const Attendance = require("../models/Attendance");
const SettingsService = require("./SettingsService");
const CompanyHolidayService = require("./CompanyHolidayService");
const { employedOnDate } = require("../utils/employment");
const { dayKey, isWorkingDay } = require("./hrPolicy");

// ─────────────────────────────────────────────────────────────────────────────
// THE DAY-RESOLUTION CHOKEPOINT.
//
// Every write to dayStatus / dayFraction / leaveRequestId goes through here.
// Those three are a DENORMALISATION of decisions that live elsewhere (an
// approved LeaveRequest, a manager's confirmation), and a denormalisation with
// two writers drifts. One door, like LeadOwnershipService.
//
// ⚠️ A FINALISED SHEET RUN MUST RECOMPUTE, NOT TRUST THIS CACHE. These fields
// are here so the daily list and the draft sheet are one cheap read. When a
// payroll run is finalised — the moment the numbers become money — it should
// re-derive each day from the LeaveRequest records and the attendance evidence,
// and treat a mismatch as a bug to surface, not a value to overwrite silently.
// ─────────────────────────────────────────────────────────────────────────────

const err = (status, message) => Object.assign(new Error(message), { status });

// Applied by the LeaveRequest module (Step 2) when a request is APPROVED.
// dayFraction 0.5 = half day (the person worked the other half), 0 = full day off.
const applyLeaveDecision = async ({ adminId, date, dayFraction, dayStatus, leaveRequestId }) => {
  if (!adminId || !date) throw err(400, "adminId and date are required");
  if (![0, 0.5, 1].includes(Number(dayFraction))) throw err(400, "dayFraction must be 0, 0.5 or 1");
  const allowed = ["half_day", "leave_paid", "comp_off", "lop", "present"];
  if (!allowed.includes(dayStatus)) throw err(400, `dayStatus must be one of ${allowed.join(", ")}`);

  // Upsert: a full-day leave has no check-in, so the row may not exist yet.
  await Attendance.updateOne(
    { adminId, date },
    {
      $set: { dayFraction: Number(dayFraction), dayStatus, leaveRequestId: leaveRequestId || null },
      $setOnInsert: { dayType: "working" },
    },
    { upsert: true }
  );
  return Attendance.findOne({ adminId, date }).lean();
};

// A manager resolving a system-closed ("incomplete") day. The evidence stays as
// the sweep found it — only the RESOLUTION changes.
//
// `outcome`, `reason` and `actorId` are recorded on the row when supplied, so a
// deduction has an author. Callers that only need the status change (the sheet's
// own convert path) may omit them and behave exactly as before.
const resolveIncompleteDay = async ({ adminId, date, dayStatus, dayFraction = 1, outcome = null, reason = "", actorId = null }) => {
  const allowed = ["present", "half_day", "absent_unexplained", "lop", "leave_paid", "comp_off"];
  if (!allowed.includes(dayStatus)) throw err(400, `dayStatus must be one of ${allowed.join(", ")}`);
  const row = await Attendance.findOne({ adminId, date });
  if (!row) throw err(404, "No attendance row for that day");
  if (row.dayStatus !== "incomplete") throw err(409, `That day is "${row.dayStatus}", not incomplete`);

  const set = { dayStatus, dayFraction: Number(dayFraction) };
  if (outcome) {
    set.resolution = {
      outcome,
      reason: String(reason || "").trim(),
      by: actorId || null,
      at: new Date(),
    };
  }
  // The precondition stays in the FILTER: two managers resolving the same day
  // at once means the second write matches nothing rather than overwriting the
  // first decision.
  const res = await Attendance.updateOne({ _id: row._id, dayStatus: "incomplete" }, { $set: set });
  if (res.matchedCount === 0) throw err(409, "That day was resolved by someone else a moment ago");
  return Attendance.findOne({ _id: row._id }).lean();
};

// ── THE THREE OUTCOMES A MANAGER CAN PICK ───────────────────────────────────
// Named here rather than in the controller so the mapping from a UI word to a
// payroll status has one home. LOP is the only one that moves money, which is
// why it is the only one that demands a reason.
const RESOLUTION_OUTCOMES = {
  full: { dayStatus: "present", dayFraction: 1, reasonRequired: false },
  half: { dayStatus: "half_day", dayFraction: 0.5, reasonRequired: false },
  lop: { dayStatus: "lop", dayFraction: 0, reasonRequired: true },
};

// The manager-facing door. Validates the outcome, enforces the reason rule, and
// delegates the write to resolveIncompleteDay — nothing here touches Attendance.
const resolveDayByOutcome = async ({ adminId, date, outcome, reason }, actorId) => {
  const spec = RESOLUTION_OUTCOMES[String(outcome || "")];
  if (!spec) throw err(400, `outcome must be one of ${Object.keys(RESOLUTION_OUTCOMES).join(", ")}`);
  const clean = String(reason || "").trim();
  if (spec.reasonRequired && !clean) {
    throw err(400, "A reason is required to mark a day loss of pay — it is the only outcome that moves money");
  }
  return resolveIncompleteDay({
    adminId,
    date,
    dayStatus: spec.dayStatus,
    dayFraction: spec.dayFraction,
    outcome: String(outcome),
    reason: clean,
    actorId,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// THE 04:00 IST SWEEP — two passes over YESTERDAY (and a bounded backlog).
//
// 04:00 because nobody is working then. Hourly would truncate someone mid-shift;
// midnight would cut off anyone working late. "Yesterday is over" is unambiguous.
//
// BOUNDED WINDOW: only the last SWEEP_WINDOW_DAYS days. After an outage the
// sweep catches up on the recent backlog and cannot reach back and rewrite
// history it was never running for.
//
// IDEMPOTENT AND RACE-SAFE: every write is a guarded updateOne whose filter
// still contains the precondition (checkOutAt: null / no existing row). Crons
// register inside httpServer.listen, so if pm2 runs more than one instance every
// instance runs this — concurrently. Nothing here reads-then-writes.
// ─────────────────────────────────────────────────────────────────────────────
const SWEEP_WINDOW_DAYS = Number(process.env.HR_SWEEP_WINDOW_DAYS) || 3;

const shiftDayKey = (dayStr, deltaDays) => {
  const [y, m, d] = dayStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return t.toISOString().slice(0, 10);
};

// Pass 1 — close forgotten check-outs.
// checkOutAt = the last EVIDENCE of presence, never an invented policy end time.
// Resolves to "incomplete", NOT "present": payroll must not pay a full day it
// has no evidence for, and must not dock someone for a browser crash either.
const autoCloseOpenDays = async (day) => {
  const open = await Attendance.find({ date: day, checkOutAt: null }, { _id: 1, checkInAt: 1, lastHeartbeatAt: 1 }).lean();
  let closed = 0;
  for (const row of open) {
    const at = row.lastHeartbeatAt || row.checkInAt;
    const res = await Attendance.updateOne(
      { _id: row._id, checkOutAt: null }, // precondition travels WITH the write
      {
        $set: {
          checkOutAt: at,
          dayStatus: "incomplete",
          closure: { by: "system", at: new Date(), reason: "no_checkout" },
        },
      }
    );
    if (res.modifiedCount) closed += 1;
  }
  return closed;
};

// Pass 2 — record that no attendance was recorded.
// ⚠️ It writes "absent_unexplained", NOT "lop". LOP is a DECISION taken at sheet
// time by a human who can see whether leave was filed late, approved, or never
// filed at all. A cron at 4am does not get to decide someone loses pay.
// Working days only — Sundays and holidays are derivable and materialising them
// would be noise.
const materialiseAbsences = async (day) => {
  const policy = await SettingsService.getMany(["hr.workingDays"]);
  if (!isWorkingDay(day, { workingDays: policy["hr.workingDays"] })) {
    return { skipped: "weekly_off" };
  }
  const holidays = await CompanyHolidayService.holidayKeysBetween(day, day);
  if (holidays.has(day)) return { skipped: "holiday" };

  const people = await employedOnDate(day);
  const existing = new Set(
    (await Attendance.find({ date: day }, { adminId: 1 }).lean()).map((r) => String(r.adminId))
  );
  let created = 0;
  let uncertain = 0;
  for (const p of people) {
    if (existing.has(String(p.admin._id))) continue;
    if (!p.certain) uncertain += 1;
    // Guarded by the unique { adminId, date } index — a concurrent instance
    // racing us loses harmlessly instead of double-writing.
    try {
      await Attendance.create({
        adminId: p.admin._id,
        date: day,
        // No check-in happened. checkInAt is required, so the day's own start is
        // the only honest stamp — and dayStatus says plainly that nothing was
        // recorded, so nothing reads this as time worked.
        checkInAt: new Date(`${day}T00:00:00.000Z`),
        checkOutAt: new Date(`${day}T00:00:00.000Z`),
        dayType: "working",
        dayStatus: "absent_unexplained",
        dayFraction: 0,
        closure: { by: "system", at: new Date(), reason: "no_attendance_recorded" },
      });
      created += 1;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e; // someone checked in as we wrote
    }
  }
  return { created, considered: people.length, uncertainEmployment: uncertain };
};

// The cron entry point. Sweeps yesterday first, then the bounded backlog.
const runDailySweep = async (now = new Date()) => {
  const today = dayKey(now);
  const out = { days: [] };
  for (let back = 1; back <= SWEEP_WINDOW_DAYS; back++) {
    const day = shiftDayKey(today, -back);
    const closed = await autoCloseOpenDays(day);
    const absences = await materialiseAbsences(day);
    out.days.push({ day, closed, ...absences });
  }
  return out;
};

module.exports = {
  RESOLUTION_OUTCOMES,
  resolveDayByOutcome,
  SWEEP_WINDOW_DAYS,
  shiftDayKey,
  applyLeaveDecision,
  resolveIncompleteDay,
  autoCloseOpenDays,
  materialiseAbsences,
  runDailySweep,
};

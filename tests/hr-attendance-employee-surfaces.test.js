/**
 * HR / PAYROLL — the four endpoints the People & Payroll S1 frontend needed.
 *
 *   1. GET  /attendance/me?month=YYYY-MM      one month of one's OWN attendance
 *   2. POST /attendance/:adminId/:date/resolve  a MANAGER resolving an incomplete day
 *   3. POST /attendance/me/:date/note           the employee's own explanation
 *   4. (3 and 4 are ONE field — see the note on Attendance.employeeNote)
 *
 *   node tests/hr-attendance-employee-surfaces.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Attendance = require("../models/Attendance");
const Admin = require("../models/Admin");
const Setting = require("../models/Setting");
const Department = require("../models/Department");
const Role = require("../models/Role");
const AttendanceService = require("../services/AttendanceService");
const AttendanceDayService = require("../services/AttendanceDayService");
const { validatePermissions } = require("../utils/rbacPermissions");
const { requirePermission } = require("../middlewares/requirePermission");
const attendanceController = require("../controllers/attendance");

const TAG = `hrsurf-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const istAt = (day, hhmm) => {
  const [y, m, d] = day.split("-").map(Number);
  const [H, M] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, H - 5, M - 30));
};
const runChain = (handlers, req) =>
  new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, send(b) { resolve({ status: this.statusCode, body: b }); }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    let i = 0;
    const next = () => {
      const h = handlers[i++];
      if (!h) return resolve({ status: res.statusCode, body: null });
      Promise.resolve(h(req, res, next)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
    };
    next();
  });

const admins = [], depts = [], roles = [];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const dept = await Department.create({ name: `${TAG}-dept` }); depts.push(dept._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, ...extra });
      admins.push(a._id);
      return a;
    };

    const sneha = await mk("Sneha", { joinedAt: new Date("2025-01-01") });
    const asha = await mk("Asha", { joinedAt: new Date("2025-01-01") });   // her manager
    const outsider = await mk("Outsider", { joinedAt: new Date("2025-01-01") });
    await Admin.updateOne({ _id: sneha._id }, { $set: { reportingManagerId: asha._id } });

    // A month of Sneha's days: a plain day, a late day, and an incomplete one.
    const seed = async (date, extra) => {
      await Attendance.create({ adminId: sneha._id, date, checkInAt: istAt(date, "11:02"), ...extra });
    };
    await seed("2026-08-03", { checkOutAt: istAt("2026-08-03", "19:30"), closure: { by: "self", at: istAt("2026-08-03", "19:30") } });
    await seed("2026-08-11", { checkOutAt: istAt("2026-08-11", "19:10"), lateMinutes: 34, fineAmount: 300, closure: { by: "self", at: istAt("2026-08-11", "19:10") } });
    await seed("2026-08-14", { checkOutAt: istAt("2026-08-14", "18:12"), dayStatus: "incomplete", closure: { by: "system", at: istAt("2026-08-15", "04:00"), reason: "auto-close" } });
    // A day in a DIFFERENT month, to prove the range is bounded.
    await seed("2026-09-01", { checkOutAt: istAt("2026-09-01", "19:00"), closure: { by: "self" } });

    // ── 1. THE MONTH ENDPOINT ───────────────────────────────────────────────
    console.log("1. GET /attendance/me?month= returns that month, login-gated only");
    const noMonth = await runChain([attendanceController.Me], { auth: { user_id: sneha._id }, query: {} });
    eq(noMonth.status, 200, "without ?month it still answers");
    ok(!("days" in noMonth.body), "…and the payload is unchanged — no `days` key, so no caller shifts");

    const m = await runChain([attendanceController.Me], { auth: { user_id: sneha._id }, query: { month: "2026-08" } });
    eq(m.status, 200, "with ?month it answers with no permission at all");
    eq(m.body.month, "2026-08", "…echoes the month");
    eq(m.body.days.length, 3, "…and returns ONLY that month's rows (September excluded)");
    ok(m.body.days.every((d) => d.date.startsWith("2026-08")), "…every row is inside the month");
    ok(m.body.days[0].date < m.body.days[2].date, "…sorted ascending by date");

    const late = m.body.days.find((d) => d.date === "2026-08-11");
    const inc = m.body.days.find((d) => d.date === "2026-08-14");
    ok(late.fineAmount === 300 && late.lateMinutes === 34, "the late mark carries its minutes and its fine");
    eq(inc.closedBy, "system", "the incomplete day reports closedBy=system — what the calendar draws on");
    eq(inc.dayStatus, "incomplete", "…and its dayStatus");
    const keys = ["date", "dayType", "dayStatus", "dayFraction", "checkInAt", "checkOutAt", "closedBy", "lateMinutes", "fineAmount", "leaveRequestId"];
    ok(keys.every((k) => k in inc), `every field the calendar needs is present (${keys.length} of them)`);

    const bad = await runChain([attendanceController.Me], { auth: { user_id: sneha._id }, query: { month: "2026-13" } });
    eq(bad.status, 400, "a malformed month is a 400, not an empty month");
    const bad2 = await runChain([attendanceController.Me], { auth: { user_id: sneha._id }, query: { month: "August" } });
    eq(bad2.status, 400, "…and so is a non-numeric one");

    // Someone else's month is simply not reachable: adminId comes from the token.
    const asMe = await AttendanceService.monthOf(asha._id, "2026-08");
    eq(asMe.length, 0, "the month is always the CALLER's own — Asha's own month is empty");

    // ── 2. MANAGER RESOLUTION ───────────────────────────────────────────────
    console.log("\n2. POST /:adminId/:date/resolve — the three outcomes");
    ok(validatePermissions(["attendance:edit:team"]).valid, "attendance:edit is already in the RBAC vocabulary — no new resource");

    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["attendance:edit:team"] });
    roles.push(mgrRole._id);
    await Admin.updateOne({ _id: asha._id }, { $set: { roleIds: [mgrRole._id] } });
    const gate = requirePermission("attendance:edit:own", { ownerField: "adminId" });

    // LOP without a reason is refused — it is the only outcome that moves money.
    const lopNoReason = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-14" }, body: { outcome: "lop" },
    });
    eq(lopNoReason.status, 400, "LOP with no reason is refused");
    ok(/reason is required/i.test(lopNoReason.body.message), "…and says why");
    eq((await Attendance.findOne({ adminId: sneha._id, date: "2026-08-14" }).lean()).dayStatus, "incomplete", "…and nothing was written");

    // Half day needs no reason.
    const half = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-14" }, body: { outcome: "half" },
    });
    eq(half.status, 200, "half day resolves without a reason");
    const afterHalf = await Attendance.findOne({ adminId: sneha._id, date: "2026-08-14" }).lean();
    eq(afterHalf.dayStatus, "half_day", "…dayStatus written through the chokepoint");
    eq(afterHalf.dayFraction, 0.5, "…and the fraction");
    eq(afterHalf.resolution.outcome, "half", "…the outcome is recorded");
    eq(String(afterHalf.resolution.by), String(asha._id), "…attributed to the manager who decided");
    ok(afterHalf.resolution.at instanceof Date, "…and timestamped");
    eq(afterHalf.closure.by, "system", "…while `closure` still says the SWEEP closed the day — evidence is not overwritten by judgement");

    // Already resolved → 409, not a silent second write.
    const again = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-14" }, body: { outcome: "full" },
    });
    eq(again.status, 409, "resolving an already-resolved day is a 409");

    // Scope: an outsider with the same permission cannot reach Sneha's day.
    await seed("2026-08-18", { checkOutAt: istAt("2026-08-18", "18:00"), dayStatus: "incomplete", closure: { by: "system" } });
    await Admin.updateOne({ _id: outsider._id }, { $set: { roleIds: [mgrRole._id] } });
    const outOfScope = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: outsider._id }, params: { adminId: String(sneha._id), date: "2026-08-18" }, body: { outcome: "full" },
    });
    eq(outOfScope.status, 403, "a manager outside the reporting line is refused");
    eq((await Attendance.findOne({ adminId: sneha._id, date: "2026-08-18" }).lean()).dayStatus, "incomplete", "…and the day is untouched");

    // With a reason, LOP goes through and carries it.
    const lop = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-18" }, body: { outcome: "lop", reason: "No contact all day; not on site." },
    });
    eq(lop.status, 200, "LOP with a reason goes through");
    const afterLop = await Attendance.findOne({ adminId: sneha._id, date: "2026-08-18" }).lean();
    eq(afterLop.dayStatus, "lop", "…dayStatus lop");
    eq(afterLop.dayFraction, 0, "…and zero fraction — the only outcome that moves money");
    eq(afterLop.resolution.reason, "No contact all day; not on site.", "…with the reason stored verbatim");

    // A day that was never incomplete cannot be resolved.
    const notInc = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-03" }, body: { outcome: "full" },
    });
    eq(notInc.status, 409, "a normal present day cannot be 'resolved'");

    const badOutcome = await runChain([gate, attendanceController.Resolve], {
      auth: { user_id: asha._id }, params: { adminId: String(sneha._id), date: "2026-08-14" }, body: { outcome: "delete" },
    });
    eq(badOutcome.status, 400, "an unknown outcome is refused");

    // ── 3+4. THE EMPLOYEE'S NOTE — ONE FIELD ────────────────────────────────
    console.log("\n3+4. POST /me/:date/note — one field for the day AND the fine");
    const note = await runChain([attendanceController.Note], {
      auth: { user_id: sneha._id }, params: { date: "2026-08-11" }, body: { text: "Metro was down at Indiranagar — left home at 10:15." },
    });
    eq(note.status, 200, "an employee can annotate their own day with no permission");
    const noted = await Attendance.findOne({ adminId: sneha._id, date: "2026-08-11" }).lean();
    eq(noted.employeeNote.text, "Metro was down at Indiranagar — left home at 10:15.", "…the note is stored");
    eq(String(noted.employeeNote.by), String(sneha._id), "…authored by them");
    ok(noted.employeeNote.at instanceof Date, "…and timestamped");

    // THE POINT: a note is context, not a waiver.
    eq(noted.fineAmount, 300, "the fine is UNCHANGED — a note explains, it does not waive");
    eq(noted.lateMinutes, 34, "…and so is the late mark");

    // The same field covers the incomplete day — "explain the day" is the same act.
    const dayNote = await runChain([attendanceController.Note], {
      auth: { user_id: sneha._id }, params: { date: "2026-08-14" }, body: { text: "Left from the Anaya site, forgot to check out." },
    });
    eq(dayNote.status, 200, "the SAME endpoint explains an incomplete day — one field, not two");
    ok((await Attendance.findOne({ adminId: sneha._id, date: "2026-08-14" }).lean()).employeeNote.text.startsWith("Left from"), "…stored on the same row the fine would be on");

    const empty = await runChain([attendanceController.Note], { auth: { user_id: sneha._id }, params: { date: "2026-08-11" }, body: { text: "   " } });
    eq(empty.status, 400, "an empty note is refused");
    const noRow = await runChain([attendanceController.Note], { auth: { user_id: asha._id }, params: { date: "2026-08-11" }, body: { text: "not mine" } });
    eq(noRow.status, 404, "you cannot annotate a day you have no row for — the note is always your own");

    // And the month read surfaces both, so the founder's run can see them.
    const m2 = await runChain([attendanceController.Me], { auth: { user_id: sneha._id }, query: { month: "2026-08" } });
    const withNote = m2.body.days.find((d) => d.date === "2026-08-11");
    ok(withNote.employeeNote && withNote.employeeNote.text, "the month payload carries the note through to whoever decides");
    const resolved = m2.body.days.find((d) => d.date === "2026-08-18");
    ok(resolved.resolution && resolved.resolution.outcome === "lop", "…and the resolution, with its author");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await Setting.deleteMany({ key: { $regex: "^hr\\." } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

const mongoose = require("mongoose");
const PayrollRun = require("../models/PayrollRun");
const EmployeeSalary = require("../models/EmployeeSalary");
const Attendance = require("../models/Attendance");
const LeaveRequest = require("../models/LeaveRequest");
const CompOff = require("../models/CompOff");
const Admin = require("../models/Admin");
const SettingsService = require("./SettingsService");
const CompanyHolidayService = require("./CompanyHolidayService");
const LeaveService = require("./LeaveService");
const { employeeFilter, employedOn } = require("../utils/employment");
const P = require("./payrollPolicy");

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const MONTH_RE = /^\d{4}-\d{2}$/;
const keyOf = (d) => `${d.adminId}|${d.kind}|${d.date}`;

// ── SALARY ──────────────────────────────────────────────────────────────────
const setSalary = async ({ adminId, annualCtc, effectiveFrom, note }, actorId) => {
  if (!isId(adminId)) throw err(400, "Invalid adminId");
  if (!(Number(annualCtc) >= 0)) throw err(400, "annualCtc must be a number >= 0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom || ""))) {
    throw err(400, 'effectiveFrom must be an IST day key "YYYY-MM-DD"');
  }
  return EmployeeSalary.findOneAndUpdate(
    { adminId, effectiveFrom },
    { $set: { annualCtc: Number(annualCtc), note: String(note || "") }, $setOnInsert: { createdBy: actorId || null } },
    { upsert: true, new: true }
  ).lean();
};

const salaryHistory = async (adminId) =>
  EmployeeSalary.find({ adminId }).sort({ effectiveFrom: -1 }).lean();

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE THE SHEET — always derived from source, never from a cache.
//
// Proposals (LOP days, late fines) are RE-DERIVED every time; founder decisions
// stored on the run are then merged onto them by (adminId, kind, date), so
// refreshing a draft never loses a decision already taken.
// ─────────────────────────────────────────────────────────────────────────────
// `adminIds` narrows the population. Production runs pass nothing and get every
// employee — a sheet that quietly omitted someone is the failure nobody notices.
// It exists for tests and for any future recompute-one-person path.
const computeSheet = async (month, decisions = [], { adminIds = null } = {}) => {
  if (!MONTH_RE.test(String(month || ""))) throw err(400, 'month must be "YYYY-MM"');
  const from = P.monthStart(month);
  const to = P.monthEnd(month);

  const workingDaysSetting = (await SettingsService.getMany(["hr.workingDays"]))["hr.workingDays"];
  const holidayKeys = await CompanyHolidayService.holidayKeysBetween(from, to);
  const workingDays = P.workingDaysIn(month, workingDaysSetting, holidayKeys);

  // The payroll population: NOT assignableFilter — that means "can receive work"
  // and drops status:"on_leave", exactly the people a sheet must explain.
  const people = await Admin.find(
    employeeFilter(adminIds ? { _id: { $in: adminIds } } : {}),
    { name: 1, email: 1, joinedAt: 1, isDisabled: 1, status: 1, meta: 1 }
  ).lean();

  const decisionBy = new Map(decisions.map((d) => [keyOf(d), d]));
  const lines = [];

  for (const admin of people) {
    const emp = employedOn(admin, to);
    const empAtStart = employedOn(admin, from);
    // Nobody employed at any point in the month has nothing to be paid for.
    if (!emp.employed && !empAtStart.employed) continue;

    const blocking = [];
    const flags = [];

    // ── salary, effective-dated ──────────────────────────────────────────
    const salaries = await EmployeeSalary.find({ adminId: admin._id }).lean();
    const governing = P.governingSalary(salaries, month);
    let gross = 0;
    if (!governing) {
      // Included at zero with a BLOCKING flag rather than omitted. A person
      // missing from payroll entirely is the failure nobody notices until they
      // ask where their salary is.
      blocking.push("No salary record — set one before finalising");
    } else {
      gross = P.monthlyGross(governing.annualCtc);
    }

    // ── pro-ration, only on KNOWN dates ─────────────────────────────────
    const joinedDay = admin.joinedAt
      ? new Date(admin.joinedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
      : null;
    const exitedDay = admin.meta && admin.meta.exitedAt
      ? new Date(admin.meta.exitedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
      : null;
    if (!joinedDay) flags.push("start date not recorded — paid a full month");
    const pro = P.prorateGross(gross, month, {
      joinedDay: joinedDay && joinedDay > from ? joinedDay : null,
      exitedDay: exitedDay && exitedDay < to ? exitedDay : null,
    });
    const payableGross = P.round2(pro.gross);
    const rate = P.dayRate(payableGross);

    // ── attendance for the month ────────────────────────────────────────
    const rows = await Attendance.find({ adminId: admin._id, date: { $gte: from, $lte: to } }).lean();
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const present = rows.filter((r) => r.dayStatus === "present").length;
    const halfDays = rows.filter((r) => r.dayStatus === "half_day").length;
    const incompleteDays = rows.filter((r) => r.dayStatus === "incomplete").map((r) => r.date).sort();

    // ── leave taken, by type ────────────────────────────────────────────
    const leaves = await LeaveRequest.find({
      adminId: admin._id, status: "approved", "days.date": { $gte: from, $lte: to },
    }).lean();
    // Always all four keys, so the shape is stable for the sheet, the export and
    // the frontend — and never an empty object (see minimize on PayrollRun).
    const leaveByType = { CL: 0, SL: 0, EL: 0, WFH: 0 };
    for (const lr of leaves) {
      for (const d of lr.days) {
        if (d.date < from || d.date > to) continue;
        leaveByType[lr.type] = P.round2((leaveByType[lr.type] || 0) + d.fraction);
      }
    }

    // ── comp-off earned and used in the month ───────────────────────────
    const compEarned = await CompOff.countDocuments({
      adminId: admin._id, earnedFor: { $gte: from, $lte: to }, status: { $in: ["granted", "consumed", "expired"] },
    });
    const compUsed = await CompOff.countDocuments({
      adminId: admin._id, consumedFor: { $gte: from, $lte: to },
    });

    // ── LOP PROPOSALS, each with where it came from ─────────────────────
    // Never applied automatically. A founder approves or waives every one.
    const autoRejected = await LeaveRequest.find({
      adminId: admin._id, status: "auto_rejected", "days.date": { $gte: from, $lte: to },
    }).lean();
    const sameDayDates = new Set(autoRejected.flatMap((r) => r.days.map((d) => d.date)));

    const lopItems = [];
    for (const r of rows) {
      let source = null;
      if (r.dayStatus === "absent_unexplained") {
        source = sameDayDates.has(r.date) ? "same_day_rejection" : "absent_unexplained";
      } else if (r.dayStatus === "lop") {
        source = "marked_lop";
      }
      if (!source) continue;
      const fraction = r.dayStatus === "half_day" ? 0.5 : 1;
      const decision = decisionBy.get(`${admin._id}|lop|${r.date}`);
      lopItems.push({
        adminId: admin._id, kind: "lop", date: r.date, source, fraction,
        amount: P.round2(rate * fraction),
        status: decision ? decision.status : "pending",
        reason: decision ? decision.reason : "",
      });
    }
    // A same-day rejection on a day with NO attendance row at all — the sweep
    // may not have reached it yet, but the no-show is still a fact.
    for (const d of sameDayDates) {
      if (byDate.has(d)) continue;
      if (!workingDays.includes(d)) continue;
      const decision = decisionBy.get(`${admin._id}|lop|${d}`);
      lopItems.push({
        adminId: admin._id, kind: "lop", date: d, source: "same_day_rejection", fraction: 1,
        amount: P.round2(rate), status: decision ? decision.status : "pending",
        reason: decision ? decision.reason : "",
      });
    }

    // ── LATE FINES, read from the SNAPSHOT on each row ───────────────────
    // Never recomputed from current settings: a policy change must not alter a
    // past month, which is the whole reason the snapshot exists.
    const fineItems = rows
      .filter((r) => Number(r.fineAmount) > 0)
      .map((r) => {
        const decision = decisionBy.get(`${admin._id}|fine|${r.date}`);
        return {
          adminId: admin._id, kind: "fine", date: r.date,
          lateMinutes: r.lateMinutes, amount: P.round2(r.fineAmount),
          policy: r.policySnapshot || null,
          status: decision ? decision.status : "pending",
          reason: decision ? decision.reason : "",
        };
      });

    const items = [...lopItems, ...fineItems].sort((a, b) => a.date.localeCompare(b.date));
    const pendingCount = items.filter((i) => i.status === "pending").length;
    if (pendingCount) blocking.push(`${pendingCount} proposed deduction(s) not yet approved or waived`);

    const lopDeduction = P.round2(lopItems.filter((i) => i.status === "approved").reduce((s, i) => s + i.amount, 0));
    const fineDeduction = P.round2(fineItems.filter((i) => i.status === "approved").reduce((s, i) => s + i.amount, 0));
    const lopDays = P.round2(lopItems.filter((i) => i.status === "approved").reduce((s, i) => s + i.fraction, 0));
    const waivedCount = items.filter((i) => i.status === "waived").length;

    if (incompleteDays.length) {
      // Surfaced prominently, deliberately NOT proposed for deduction and NOT
      // blocking: an unactioned incomplete day is PAID. A founder can convert it
      // to LOP from the sheet if they judge it a no-show.
      flags.push(`${incompleteDays.length} incomplete day(s) needing confirmation — paid unless converted`);
    }

    const totalDeductions = P.round2(lopDeduction + fineDeduction);
    const closingBalances = await LeaveService.balancesFor(admin._id, Number(month.slice(0, 4)));

    lines.push({
      adminId: admin._id,
      name: admin.name,
      email: admin.email,
      employeeId: (admin.meta && admin.meta.employeeId) || "",
      annualCtc: governing ? governing.annualCtc : 0,
      salaryEffectiveFrom: governing ? governing.effectiveFrom : null,
      monthlyGross: P.round2(gross),
      payableGross,
      prorated: pro.prorated,
      daysEmployed: pro.daysEmployed,
      dayRate: P.round2(rate),
      present, halfDays,
      incompleteDays,
      leaveByType,
      compOffEarned: compEarned,
      compOffUsed: compUsed,
      items,
      lopDays, lopDeduction,
      lateInstances: fineItems.length,
      fineDeduction,
      waivedCount,
      totalDeductions,
      netBeforeStatutory: P.round2(payableGross - totalDeductions),
      closingBalances,
      flags,
      blocking,
      employmentCertain: emp.certain,
    });
  }

  lines.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const totals = {
    headcount: lines.length,
    gross: P.round2(lines.reduce((s, l) => s + l.payableGross, 0)),
    lopDeduction: P.round2(lines.reduce((s, l) => s + l.lopDeduction, 0)),
    fineDeduction: P.round2(lines.reduce((s, l) => s + l.fineDeduction, 0)),
    totalDeductions: P.round2(lines.reduce((s, l) => s + l.totalDeductions, 0)),
    netBeforeStatutory: P.round2(lines.reduce((s, l) => s + l.netBeforeStatutory, 0)),
    pendingItems: lines.reduce((s, l) => s + l.items.filter((i) => i.status === "pending").length, 0),
    blockingLines: lines.filter((l) => l.blocking.length).length,
  };
  return {
    month, dayDivisor: P.DAY_DIVISOR,
    workingDaysInMonth: workingDays.length, daysInMonth: P.daysInMonth(month),
    lines, totals,
  };
};

// ── RUN LIFECYCLE ───────────────────────────────────────────────────────────
const getOrCreateRun = async (month, actorId) => {
  if (!MONTH_RE.test(String(month || ""))) throw err(400, 'month must be "YYYY-MM"');
  const existing = await PayrollRun.findOne({ month });
  if (existing) return existing;
  try {
    return await PayrollRun.create({ month, createdBy: actorId || null });
  } catch (e) {
    if (e && e.code === 11000) return PayrollRun.findOne({ month });
    throw e;
  }
};

// A finalised run serves its FROZEN snapshot; a draft recomputes every time.
const getSheet = async (month, actorId, opts = {}) => {
  const run = await getOrCreateRun(month, actorId);
  if (run.status === "finalised") {
    return { run: run.toObject(), sheet: run.snapshot, frozen: true };
  }
  const sheet = await computeSheet(month, run.decisions || [], opts);
  return { run: run.toObject(), sheet, frozen: false };
};

// Approve or waive ONE proposed deduction. Nothing is deducted until this runs.
const actOnItem = async (month, { adminId, kind, date, action, reason }, actorId, opts = {}) => {
  const run = await getOrCreateRun(month, actorId);
  if (run.status === "finalised") throw err(409, "This run is finalised and cannot be changed");
  if (!["approve", "waive", "reset"].includes(action)) throw err(400, 'action must be "approve", "waive" or "reset"');
  if (!isId(adminId)) throw err(400, "Invalid adminId");
  if (!["lop", "fine"].includes(kind)) throw err(400, 'kind must be "lop" or "fine"');
  const clean = String(reason || "").trim();
  // A waiver is a decision to forgo money. It needs a stated reason, the same
  // way an overridden price does.
  if (action === "waive" && !clean) throw err(400, "A reason is required when you waive a deduction");

  const k = `${adminId}|${kind}|${date}`;
  const next = (run.decisions || []).filter((d) => keyOf(d) !== k);
  if (action !== "reset") {
    next.push({
      adminId, kind, date,
      status: action === "approve" ? "approved" : "waived",
      reason: clean, decidedBy: actorId || null, decidedAt: new Date(),
    });
  }
  await PayrollRun.updateOne({ _id: run._id, status: "draft" }, { $set: { decisions: next } });
  return getSheet(month, actorId, opts);
};

// Convert an unresolved `incomplete` day into a LOP proposal, via the attendance
// chokepoint — this service never writes dayStatus directly.
const convertIncompleteToLop = async (month, { adminId, date }, actorId, opts = {}) => {
  const run = await getOrCreateRun(month, actorId);
  if (run.status === "finalised") throw err(409, "This run is finalised and cannot be changed");
  const AttendanceDayService = require("./AttendanceDayService");
  await AttendanceDayService.resolveIncompleteDay({ adminId, date, dayStatus: "lop", dayFraction: 0 });
  return getSheet(month, actorId, opts);
};

// ── FINALISE ────────────────────────────────────────────────────────────────
// RECOMPUTES from source first — never trusts the draft's numbers — then checks
// nothing is unactioned or blocking, then freezes. Terminal: there is no
// re-opening, and a correction is an adjustment on the next month's run.
const finalise = async (month, actorId, opts = {}) => {
  const run = await getOrCreateRun(month, actorId);
  if (run.status === "finalised") throw err(409, "This run is already finalised");

  const sheet = await computeSheet(month, run.decisions || [], opts);

  if (sheet.totals.pendingItems > 0) {
    throw err(409, `${sheet.totals.pendingItems} proposed deduction(s) are still unactioned — approve or waive each one before finalising`, {
      code: "UNACTIONED_ITEMS",
    });
  }
  const blocked = sheet.lines.filter((l) => l.blocking.length);
  if (blocked.length) {
    throw err(409, `${blocked.length} employee(s) cannot be finalised: ${blocked[0].name} — ${blocked[0].blocking[0]}`, {
      code: "BLOCKING_FLAGS",
      blocked: blocked.map((l) => ({ adminId: l.adminId, name: l.name, blocking: l.blocking })),
    });
  }

  const claimed = await PayrollRun.updateOne(
    { _id: run._id, status: "draft" },
    { $set: { status: "finalised", snapshot: sheet, totals: sheet.totals, dayDivisor: P.DAY_DIVISOR, finalisedBy: actorId || null, finalisedAt: new Date() } }
  );
  if (!claimed.modifiedCount) throw err(409, "This run was finalised by someone else");
  return { run: (await PayrollRun.findById(run._id)).toObject(), sheet };
};

const listRuns = async () => PayrollRun.find({}, { snapshot: 0 }).sort({ month: -1 }).lean();

module.exports = {
  setSalary, salaryHistory, computeSheet, getOrCreateRun, getSheet,
  actOnItem, convertIncompleteToLop, finalise, listRuns,
};

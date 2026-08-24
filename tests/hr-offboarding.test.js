/**
 * OFFBOARDING (2026-08-25).
 *
 * Six of fifteen active admins left on 2026-08-01 and were still fully active -
 * holding roles, blocking payroll, eligible for leave, able to log in.
 *
 * The rules under test: an exit is DATED and not retroactive, access is revoked,
 * the org chart cannot be silently orphaned, history survives, and an explicit
 * zero salary is a DECISION while a missing one is a GAP.
 *
 *   node tests/hr-offboarding.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Attendance = require("../models/Attendance");
const LeaveRequest = require("../models/LeaveRequest");
const LeaveBalance = require("../models/LeaveBalance");
const EmployeeSalary = require("../models/EmployeeSalary");
const PayrollRun = require("../models/PayrollRun");
const Offboarding = require("../services/OffboardingService");
const LeaveService = require("../services/LeaveService");
const PayrollService = require("../services/PayrollService");
const AttendanceDayService = require("../services/AttendanceDayService");
const { employedOn, employedOnDate, hasExited } = require("../utils/employment");
const { assignableFilter } = require("../utils/assignable");

const TAG = `off-${Date.now()}`;
const EXIT = "2026-08-01";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  \u2713 ${label}`); } else { fail++; console.error(`  \u2717 ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const admins = [], roles = [], depts = [];
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    await PayrollRun.deleteMany({ month: { $in: ["2026-08", "2026-09"] } });
    const dept = await Department.create({ name: `${TAG}-d` }); depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-f`, departmentId: dept._id, permissions: ["payroll:approve:all", "payroll:view:all", "leave:approve:all"] });
    roles.push(founderRole._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01"), ...extra });
      admins.push(a._id); return a;
    };
    const founder = await mk("Founder", { roleIds: [founderRole._id] });
    const leaver = await mk("Leaver", { reportingManagerId: founder._id });
    const stayer = await mk("Stayer", { reportingManagerId: founder._id });
    const SCOPE = () => ({ adminIds: admins });

    // history that must survive
    await Attendance.create({ adminId: leaver._id, date: "2026-07-15", checkInAt: new Date("2026-07-15T06:00:00Z"), dayStatus: "present", lateMinutes: 35, fineAmount: 300, policySnapshot: { workStartTime: "11:00", graceMinutes: 20, lateBands: [], source: "company" } });
    const oldLeave = await LeaveRequest.create({ adminId: leaver._id, type: "CL", days: [{ date: "2026-07-20", fraction: 1 }], totalDays: 1, status: "approved" });
    await PayrollService.setSalary({ adminId: leaver._id, annualCtc: 600000, effectiveFrom: "2025-01-01" }, founder._id);
    await PayrollService.setSalary({ adminId: stayer._id, annualCtc: 600000, effectiveFrom: "2025-01-01" }, founder._id);

    // -- 1. THE ORG-CHART GUARD -------------------------------------------
    console.log("1. an exit cannot silently orphan the org chart");
    const withReports = await mk("Manager", { reportingManagerId: founder._id });
    const report = await mk("Report", { reportingManagerId: withReports._id });
    const impact = await Offboarding.exitImpact(withReports._id);
    eq(impact.blocked, true, "exitImpact warns BEFORE anyone commits to a date");
    eq(impact.directReports.length, 1, "…naming the report that would be orphaned");
    const refused = await threw(() => Offboarding.recordExit({ adminId: withReports._id, exitedAt: EXIT }, founder._id));
    eq(refused && refused.status, 409, "recordExit REFUSES while direct reports remain");
    eq(refused && refused.code, "HAS_DIRECT_REPORTS", "…with a code the UI can branch on");
    eq((await Admin.findById(withReports._id).lean()).status, "active", "…and nothing was written");

    const toExited = await threw(() => Offboarding.recordExit({ adminId: withReports._id, exitedAt: EXIT, reassignTo: withReports._id }, founder._id));
    ok(toExited && /Cannot reassign reports to the person leaving/.test(toExited.message), "…cannot reassign reports to the leaver");
    const done = await Offboarding.recordExit({ adminId: withReports._id, exitedAt: EXIT, reassignTo: founder._id }, founder._id);
    eq(done.reassigned, 1, "with reassignTo the exit proceeds");
    eq(String((await Admin.findById(report._id).lean()).reportingManagerId), String(founder._id), "…and the report now reports to the new manager");

    // -- 2. THE EXIT RECORD ------------------------------------------------
    console.log("\n2. what an exit writes");
    const out = await Offboarding.recordExit({ adminId: leaver._id, exitedAt: EXIT, reason: "Left Wedsy" }, founder._id);
    const rec = await Admin.findById(leaver._id).lean();
    eq(rec.status, "exited", "status -> exited");
    eq(rec.isDisabled, true, "isDisabled -> true: access revoked");
    eq(new Date(rec.meta.exitedAt).toISOString().slice(0, 10), EXIT, "meta.exitedAt is the last working day");
    eq(rec.meta.exitReason, "Left Wedsy", "…with the reason");
    eq(String(rec.meta.exitRecordedBy), String(founder._id), "…who recorded it");
    ok(!!rec.meta.exitRecordedAt, "…and when");
    const again = await threw(() => Offboarding.recordExit({ adminId: leaver._id, exitedAt: EXIT }, founder._id));
    eq(again && again.status, 409, "a second exit is refused - idempotent");
    const backwards = await threw(() => Offboarding.recordExit({ adminId: stayer._id, exitedAt: "2024-01-01" }, founder._id));
    ok(backwards && /cannot precede/.test(backwards.message), "an exit before the join date is refused");

    // status and access stay DISTINCT concepts
    const suspended = await mk("Suspended", { isDisabled: true });
    eq((await Admin.findById(suspended._id).lean()).status, "active",
      "someone can be locked out while still EMPLOYED - the two fields are independent");

    // -- 3. NOT RETROACTIVE ------------------------------------------------
    console.log("\n3. the exit is dated, and never retroactive");
    eq(employedOn(rec, "2026-07-15").employed, true, "employed in July - a month they worked still computes");
    eq(employedOn(rec, EXIT).employed, true, "employed ON the last working day (inclusive)");
    eq(employedOn(rec, "2026-08-02").employed, false, "not employed the day after");
    eq(employedOn(rec, "2026-08-02").certain, true, "…and that answer is certain, not a guess");
    ok(/exited 2026-08-01/.test(employedOn(rec, "2026-09-10").reason), "…with the date in the reason");
    eq(out.employedOnLastDay, true, "recordExit reports the non-retroactivity it just preserved");
    eq(out.employedDayAfter, false, "…and the cutoff");
    eq(hasExited(rec, "2026-09-01"), true, "hasExited is true after the date");
    eq(hasExited(rec, "2026-07-01"), false, "…and false before it");

    // -- 4. EXCLUDED GOING FORWARD -----------------------------------------
    console.log("\n4. excluded from payroll, leave and the sweep - forward only");
    const augPeople = (await employedOnDate("2026-08-01")).map((p) => String(p.admin._id));
    ok(augPeople.includes(String(leaver._id)), "the absence sweep still includes them on their last day");
    const sepPeople = (await employedOnDate("2026-09-10")).map((p) => String(p.admin._id));
    ok(!sepPeople.includes(String(leaver._id)), "…and excludes them afterwards");

    const augSheet = (await PayrollService.getSheet("2026-08", founder._id, SCOPE())).sheet;
    ok(!!augSheet.lines.find((l) => String(l.adminId) === String(leaver._id)), "AUGUST payroll still includes them - they worked that month");
    const sepSheet = (await PayrollService.getSheet("2026-09", founder._id, SCOPE())).sheet;
    ok(!sepSheet.lines.find((l) => String(l.adminId) === String(leaver._id)), "SEPTEMBER payroll excludes them");

    const leaveTry = await threw(() => LeaveService.apply({ type: "CL", days: [{ date: "2026-09-14", fraction: 1 }], reason: "x" }, leaver._id, new Date("2026-09-01T06:00:00Z")));
    eq(leaveTry && leaveTry.status, 403, "they cannot apply for leave dated after the exit");
    ok(/left the company/.test(leaveTry.message), `…with a sentence that explains (${leaveTry.message})`);

    // assignment selectors drop them the moment status flips
    const assignable = await Admin.find(assignableFilter({ _id: { $in: admins } }), { _id: 1 }).lean();
    ok(!assignable.map((a) => String(a._id)).includes(String(leaver._id)),
      "assignableFilter drops them at once - that is what the status value is FOR");

    // approver routing must not reach them
    const exFounder = await mk("ExFounder", { roleIds: [founderRole._id] });
    await Offboarding.recordExit({ adminId: exFounder._id, exitedAt: EXIT }, founder._id);
    const holders = (await LeaveService.holdersOfApproveAll()).map(String);
    ok(!holders.includes(String(exFounder._id)), "a leaver who still HOLDS the approve role is not routed to");
    ok(holders.includes(String(founder._id)), "…while the remaining founder is");

    // -- 5. HISTORY PRESERVED ----------------------------------------------
    console.log("\n5. nothing is deleted");
    ok(!!(await Admin.findById(leaver._id)), "the admin record survives");
    eq(await Attendance.countDocuments({ adminId: leaver._id }), 1, "their attendance survives");
    const att = await Attendance.findOne({ adminId: leaver._id }).lean();
    eq(att.fineAmount, 300, "…with the fine and its snapshot intact");
    ok(!!(await LeaveRequest.findById(oldLeave._id)), "their approved leave survives");
    eq(await EmployeeSalary.countDocuments({ adminId: leaver._id }), 1, "their salary history survives");
    const augLine = augSheet.lines.find((l) => String(l.adminId) === String(leaver._id));
    ok(augLine.payableGross > 0, `…and August still pays them (prorated: ${augLine.prorated}, ${augLine.daysEmployed} day(s))`);
    eq(augLine.daysEmployed, 1, "…for exactly the one day they were employed");

    // -- 6. ZERO IS A DECISION, BLANK IS A GAP ------------------------------
    console.log("\n6. an explicit zero salary is a decision, not a gap");
    const noSalary = await mk("NoSalary");
    const zeroSalary = await mk("ZeroSalary");
    await PayrollService.setSalary({ adminId: zeroSalary._id, annualCtc: 0, effectiveFrom: "2025-01-01", note: "founder - draws nothing here" }, founder._id);
    const sheet6 = (await PayrollService.getSheet("2026-09", founder._id, SCOPE())).sheet;
    const gap = sheet6.lines.find((l) => String(l.adminId) === String(noSalary._id));
    const zero = sheet6.lines.find((l) => String(l.adminId) === String(zeroSalary._id));
    ok(gap.blocking.some((b) => /No salary record/.test(b)), "a MISSING record BLOCKS the run");
    eq(zero.blocking.length, 0, "an explicit zero does NOT block");
    eq(zero.payableGross, 0, "…pays zero");
    ok(zero.flags.some((f) => /no salary drawn through this system/.test(f)), `…and SAYS so on the sheet ("${zero.flags.find((f) => /no salary/.test(f))}")`);
    ok(!gap.flags.some((f) => /no salary drawn/.test(f)), "…while the gap is not dressed up as a decision");

    // and with zero recorded, a founder no longer blocks the run forever
    await PayrollService.setSalary({ adminId: noSalary._id, annualCtc: 0, effectiveFrom: "2025-01-01" }, founder._id);
    const sheet6b = (await PayrollService.getSheet("2026-09", founder._id, SCOPE())).sheet;
    const wasGap = sheet6b.lines.find((l) => String(l.adminId) === String(noSalary._id));
    eq(wasGap.blocking.length, 0, "once recorded as zero, that person no longer blocks the run");
    ok(wasGap.flags.some((f) => /no salary drawn/.test(f)), "…and now reads as a decision instead");
    // Everyone still blocking is blocking for the RIGHT reason - a genuine gap.
    const stillBlocked = sheet6b.lines.filter((l) => l.blocking.length);
    ok(stillBlocked.every((l) => l.blocking.some((b) => /No salary record/.test(b))),
      `remaining blocks are all genuine missing records (${stillBlocked.length})`);

    // -- 7. SERVICE ACCOUNT -------------------------------------------------
    console.log("\n7. a service account is flagged, not exited");
    const svc = await mk("SvcAcct");
    const flagged = await Offboarding.markServiceAccount(svc._id, founder._id);
    eq(flagged.meta.isServiceAccount, true, "the flag is set");
    eq((await Admin.findById(svc._id).lean()).status, "active", "…without pretending it left - it was never a person");
    const sheet7 = (await PayrollService.getSheet("2026-09", founder._id, SCOPE())).sheet;
    ok(!sheet7.lines.find((l) => String(l.adminId) === String(svc._id)), "…and it is off the payroll sheet entirely");
    eq(employedOn(flagged, "2026-09-01").employed, false, "…and never 'employed'");
  } catch (e) {
    fail++; console.error("  \u2717 threw:", e);
  } finally {
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await LeaveRequest.deleteMany({ adminId: { $in: admins } });
    await LeaveBalance.deleteMany({ adminId: { $in: admins } });
    await EmployeeSalary.deleteMany({ adminId: { $in: admins } });
    await PayrollRun.deleteMany({ month: { $in: ["2026-08", "2026-09"] } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

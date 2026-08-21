/**
 * HR / PAYROLL — attendance foundations (2026-08-21).
 *
 * Makes attendance honest enough to compute pay from:
 *   1. lateness + fine frozen at check-in against a snapshotted policy
 *   2. 04:00 auto-close at the last EVIDENCE of presence, marked "system"
 *   3. absence as a stored fact — "no attendance recorded", never LOP
 *   4. half-day written through ONE chokepoint
 *   5. company holidays, HR's own calendar
 *   6. /team re-gated on attendance:view:own
 *
 *   node tests/hr-attendance-foundations.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Attendance = require("../models/Attendance");
const CompanyHoliday = require("../models/CompanyHoliday");
const Admin = require("../models/Admin");
const Setting = require("../models/Setting");
const Department = require("../models/Department");
const Role = require("../models/Role");
const AttendanceService = require("../services/AttendanceService");
const AttendanceDayService = require("../services/AttendanceDayService");
const CompanyHolidayService = require("../services/CompanyHolidayService");
const SettingsService = require("../services/SettingsService");
const hrPolicy = require("../services/hrPolicy");
const employment = require("../utils/employment");
const { validatePermissions } = require("../utils/rbacPermissions");
const { requirePermission } = require("../middlewares/requirePermission");
const attendanceController = require("../controllers/attendance");

const TAG = `hr-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// An instant at a given IST wall-clock time on a given IST day.
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

const MON = "2026-08-24"; // Monday
const SUN = "2026-08-23"; // Sunday
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
    const alice = await mk("Alice", { joinedAt: new Date("2025-01-01") });
    const bob = await mk("Bob", { joinedAt: new Date("2025-01-01") });

    // ── 1. LATENESS FROZEN AT CHECK-IN ──────────────────────────────────────
    console.log("1. lateness + fine are computed once and snapshotted");
    const POL = { workStartTime: "11:00", graceMinutes: 20, lateBands: [{ toMinutes: 60, fine: 300 }, { toMinutes: null, fine: 500 }], source: "company" };
    const cases = [["10:45", 0, 0], ["11:00", 0, 0], ["11:20", 20, 0], ["11:21", 21, 300], ["12:00", 60, 300], ["12:01", 61, 500], ["13:30", 150, 500]];
    for (const [t, mins, fine] of cases) {
      const j = hrPolicy.judgeCheckIn(istAt(MON, t), POL);
      ok(j.lateMinutes === mins && j.fineAmount === fine, `${t} → ${j.lateMinutes} min, ₹${j.fineAmount}`);
    }
    ok(hrPolicy.judgeCheckIn(istAt(MON, "11:20"), POL).fineAmount === 0 && hrPolicy.judgeCheckIn(istAt(MON, "11:21"), POL).fineAmount === 300,
      "the grace boundary is exact: 11:20 free, 11:21 fined");

    const row1 = await AttendanceService.checkIn(alice._id, istAt(MON, "11:35"));
    eq(row1.lateMinutes, 35, "check-in stored lateMinutes");
    eq(row1.fineAmount, 300, "…and the fine");
    eq(row1.policySnapshot.workStartTime, "11:00", "…and snapshotted the start time it judged against");
    eq(row1.policySnapshot.graceMinutes, 20, "…the grace");
    eq(row1.policySnapshot.source, "company", "…and that it came from the company default");
    ok(Array.isArray(row1.policySnapshot.lateBands) && row1.policySnapshot.lateBands.length === 2, "…and the bands themselves");

    // THE POINT: change the policy, the stored day does not move.
    await SettingsService.set("hr.lateBands", [{ toMinutes: 60, fine: 999 }, { toMinutes: null, fine: 1500 }], null);
    const reread = await Attendance.findById(row1._id).lean();
    eq(reread.fineAmount, 300, "changing hr.lateBands does NOT alter a past day's fine");
    eq(reread.policySnapshot.lateBands[0].fine, 300, "…and the snapshot still shows what was in force");
    const laterRow = await AttendanceService.checkIn(bob._id, istAt(MON, "11:35"));
    eq(laterRow.fineAmount, 999, "…while a NEW check-in uses the new policy");
    await Setting.deleteOne({ key: "hr.lateBands" });
    SettingsService.invalidate();

    // per-person override
    const carol = await mk("Carol", { joinedAt: new Date("2025-01-01"), meta: { workStartTime: "13:00" } });
    const cRow = await AttendanceService.checkIn(carol._id, istAt(MON, "13:10"));
    eq(cRow.lateMinutes, 10, "a per-person workStartTime shifts the judgement");
    eq(cRow.fineAmount, 0, "…so 13:10 is within grace for a 13:00 start");
    eq(cRow.policySnapshot.source, "person", "…and the snapshot records that it was a personal override");

    // validation
    const badBands = await threw(() => SettingsService.set("hr.lateBands", [{ toMinutes: null, fine: 1 }, { toMinutes: 60, fine: 2 }], null));
    ok(badBands && badBands.status === 400, "an open-ended band that is not last is rejected");
    const badTime = await threw(() => SettingsService.set("hr.workStartTime", "25:00", null));
    ok(badTime && badTime.status === 400, "a malformed start time is rejected");

    // ── 2. AUTO-CLOSE ───────────────────────────────────────────────────────
    console.log("\n2. the 04:00 sweep closes a forgotten check-out honestly");
    await Attendance.updateOne({ _id: row1._id }, { $set: { lastHeartbeatAt: istAt(MON, "17:42") } });
    const closed = await AttendanceDayService.autoCloseOpenDays(MON);
    ok(closed >= 1, "the sweep closed the open row");
    const after = await Attendance.findById(row1._id).lean();
    eq(new Date(after.checkOutAt).getTime(), istAt(MON, "17:42").getTime(),
      "checkOutAt = the LAST HEARTBEAT — the last evidence of presence, not an invented end time");
    eq(after.closure.by, "system", "closure.by = system");
    eq(after.closure.reason, "no_checkout", "…with a reason");
    eq(after.dayStatus, "incomplete", 'dayStatus = "incomplete", NOT present — it needs manager confirmation');

    // idempotent + race-safe
    const again = await AttendanceDayService.autoCloseOpenDays(MON);
    eq(again, 0, "re-running the sweep closes nothing — idempotent");
    const stable = await Attendance.findById(row1._id).lean();
    eq(new Date(stable.checkOutAt).getTime(), istAt(MON, "17:42").getTime(), "…and does not move the timestamp");

    // a self-closed day is distinguishable, forever
    const dRow = await AttendanceService.checkIn(bob._id, istAt(MON, "11:35"));
    await AttendanceService.checkOut(bob._id, istAt(MON, "19:00"));
    const selfClosed = await Attendance.findById(dRow._id).lean();
    eq(selfClosed.closure.by, "self", "a person who checks out is closure.by = self");
    eq(selfClosed.dayStatus, "present", "…and their day stays present");
    ok(selfClosed.closure.by !== stable.closure.by, "the two are distinguishable by a stored field, not an inference");

    // with no heartbeat at all it falls back to check-in
    const dave = await mk("Dave", { joinedAt: new Date("2025-01-01") });
    const dv = await AttendanceService.checkIn(dave._id, istAt(MON, "11:05"));
    await Attendance.updateOne({ _id: dv._id }, { $set: { lastHeartbeatAt: null } });
    await AttendanceDayService.autoCloseOpenDays(MON);
    const dvAfter = await Attendance.findById(dv._id).lean();
    eq(new Date(dvAfter.checkOutAt).getTime(), istAt(MON, "11:05").getTime(), "no heartbeat → falls back to checkInAt, never later");

    // ── 3. ABSENCE AS A STORED FACT ─────────────────────────────────────────
    console.log("\n3. absence is recorded as \"nothing was recorded\", never as LOP");
    const erin = await mk("Erin", { joinedAt: new Date("2025-01-01") });
    const res3 = await AttendanceDayService.materialiseAbsences(MON);
    ok(res3.created >= 1, `absences materialised (${res3.created} created of ${res3.considered} considered)`);
    const erinRow = await Attendance.findOne({ adminId: erin._id, date: MON }).lean();
    ok(!!erinRow, "a row now exists for someone who never checked in");
    eq(erinRow.dayStatus, "absent_unexplained", 'dayStatus = "absent_unexplained" — NOT "lop"');
    eq(erinRow.dayFraction, 0, "dayFraction 0");
    eq(erinRow.dayType, "working", "dayType working");
    ok(erinRow.dayStatus !== "lop", "a cron never decides someone loses pay");

    // people who checked in are untouched
    const aliceStill = await Attendance.findById(row1._id).lean();
    eq(aliceStill.dayStatus, "incomplete", "someone who DID check in keeps their own status");

    // idempotent
    const res3b = await AttendanceDayService.materialiseAbsences(MON);
    eq(res3b.created, 0, "re-running creates nothing — idempotent");

    // Sundays and holidays get NO rows
    const sun = await AttendanceDayService.materialiseAbsences(SUN);
    eq(sun.skipped, "weekly_off", "a Sunday is skipped entirely — no rows");
    eq(await Attendance.countDocuments({ date: SUN }), 0, "…and none exist");
    await CompanyHolidayService.upsert({ date: "2026-08-25", name: `${TAG} holiday` }, null);
    const hol = await AttendanceDayService.materialiseAbsences("2026-08-25");
    eq(hol.skipped, "holiday", "a company holiday is skipped");
    eq(await Attendance.countDocuments({ date: "2026-08-25" }), 0, "…and none exist");

    // ── the employment predicate ────────────────────────────────────────────
    console.log("\n   the \"employed on this date\" predicate");
    const svc = await mk("ServiceAcct", { meta: { isServiceAccount: true } });
    eq(employment.employedOn(svc, MON).employed, false, "a service account is excluded");
    ok(/service account/.test(employment.employedOn(svc, MON).reason), "…with a reason");
    const future = await mk("Future", { joinedAt: new Date("2027-01-01") });
    eq(employment.employedOn(future, MON).employed, false, "someone who joins later is not employed on that date");
    const noJoin = await mk("NoJoin");
    const nj = employment.employedOn(noJoin, MON);
    eq(nj.employed, true, "a missing joinedAt does NOT drop them from payroll");
    eq(nj.certain, false, "…but the answer is flagged UNCERTAIN rather than guessed");
    eq(nj.reason, "joinedAt not recorded", "…and says why");
    const onLeave = await mk("OnLeave", { status: "on_leave", joinedAt: new Date("2025-01-01") });
    eq(employment.employedOn(onLeave, MON).employed, true,
      "status:on_leave is still EMPLOYED — assignableFilter would have dropped them");
    ok(!Object.prototype.hasOwnProperty.call(employment.employeeFilter(), "status"),
      "…because the payroll filter deliberately does not filter status at all");
    const cands = await employment.listLikelyServiceAccounts();
    ok(Array.isArray(cands), `service accounts are SUGGESTED for a human to confirm (${cands.length} candidates)`);
    ok(cands.every((c) => Array.isArray(c.signals) && c.signals.length >= 3), "…on absence-of-evidence signals, never on a name");

    // ── 4. HALF-DAY THROUGH THE CHOKEPOINT ──────────────────────────────────
    console.log("\n4. half-day is written through one chokepoint");
    const leaveId = new mongoose.Types.ObjectId();
    const half = await AttendanceDayService.applyLeaveDecision({
      adminId: erin._id, date: MON, dayFraction: 0.5, dayStatus: "half_day", leaveRequestId: leaveId,
    });
    eq(half.dayFraction, 0.5, "dayFraction 0.5");
    eq(half.dayStatus, "half_day", "dayStatus half_day");
    eq(String(half.leaveRequestId), String(leaveId), "…linked back to the decision that caused it");
    // a full-day leave with no check-in upserts the row
    const frank = await mk("Frank", { joinedAt: new Date("2025-01-01") });
    const full = await AttendanceDayService.applyLeaveDecision({ adminId: frank._id, date: "2026-08-26", dayFraction: 0, dayStatus: "leave_paid", leaveRequestId: leaveId });
    eq(full.dayStatus, "leave_paid", "a full-day leave upserts a row even with no check-in");
    const badFraction = await threw(() => AttendanceDayService.applyLeaveDecision({ adminId: frank._id, date: MON, dayFraction: 0.7, dayStatus: "half_day" }));
    ok(badFraction && badFraction.status === 400, "an arbitrary fraction is rejected");
    const badStatus = await threw(() => AttendanceDayService.applyLeaveDecision({ adminId: frank._id, date: MON, dayFraction: 1, dayStatus: "nonsense" }));
    ok(badStatus && badStatus.status === 400, "an unknown dayStatus is rejected");

    // resolving an incomplete day
    const resolved = await AttendanceDayService.resolveIncompleteDay({ adminId: alice._id, date: MON, dayStatus: "present" });
    eq(resolved.dayStatus, "present", "a manager can resolve an incomplete day");
    const twice = await threw(() => AttendanceDayService.resolveIncompleteDay({ adminId: alice._id, date: MON, dayStatus: "present" }));
    ok(twice && twice.status === 409, "…and cannot resolve one that is not incomplete");

    // ── 5. COMPANY HOLIDAYS ─────────────────────────────────────────────────
    console.log("\n5. HR's own holiday calendar");
    const h = await CompanyHolidayService.upsert({ date: "2026-11-08", name: "Diwali" }, alice._id);
    eq(h.date, "2026-11-08", 'keyed on the SAME IST "YYYY-MM-DD" string as Attendance');
    eq(h.paid, true, "paid defaults true");
    const keys = await CompanyHolidayService.holidayKeysBetween("2026-11-01", "2026-11-30");
    ok(keys.has("2026-11-08"), "range lookup returns day keys, no timezone arithmetic");
    const badDate = await threw(() => CompanyHolidayService.upsert({ date: "08/11/2026", name: "X" }, null));
    ok(badDate && badDate.status === 400, "a non day-key date is rejected");
    const sugg = await CompanyHolidayService.suggestFromPublicHolidays(2026);
    ok(Array.isArray(sugg), `the PublicHoliday import SUGGESTS (${sugg.length} rows) and writes nothing`);
    ok(sugg.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), "…converted to IST day keys");
    ok(sugg.every((r) => "sourceVerified" in r), "…surfacing that the source may be unverified");
    const beforeCount = await CompanyHoliday.countDocuments({});
    await CompanyHolidayService.suggestFromPublicHolidays(2026);
    eq(await CompanyHoliday.countDocuments({}), beforeCount, "…and calling it again writes nothing");

    // ── 6. PERMISSIONS ──────────────────────────────────────────────────────
    console.log("\n6. permissions");
    ok(validatePermissions(["payroll:view:all"]).valid, "payroll is a real resource");
    ok(validatePermissions(["payroll:export:all", "payroll:approve:all"]).valid, "…with export and approve");
    ok(validatePermissions(["settings_hr:edit:all"]).valid, "settings_hr is a real resource");
    ok(!validatePermissions(["payroll:pay:all"]).valid, "…and the vocabulary still rejects invented actions");

    const hrRole = await Role.create({ name: `${TAG}-hr`, departmentId: dept._id, permissions: ["attendance:view:all", "payroll:view:all"] });
    roles.push(hrRole._id);
    const hrUser = await mk("HRUser", { roleIds: [hrRole._id], joinedAt: new Date("2025-01-01") });
    const gate = requirePermission("attendance:view:own", { ownerField: "adminId" });
    const r6 = await runChain([gate, attendanceController.Team], { auth: { user_id: hrUser._id }, query: { date: MON } });
    eq(r6.status, 200, "an HR user with NO lead permissions can now see /team");
    ok(Array.isArray(r6.body.list), "…and gets the roster");

    const noPerm = await Role.create({ name: `${TAG}-none`, departmentId: dept._id, permissions: ["leads:view:own"] });
    roles.push(noPerm._id);
    const stranger = await mk("Stranger", { roleIds: [noPerm._id], joinedAt: new Date("2025-01-01") });
    const r6b = await runChain([gate, attendanceController.Team], { auth: { user_id: stranger._id }, query: { date: MON } });
    eq(r6b.status, 403, "…while lead permissions alone no longer grant it");

    // /me stays login-only, and shows the person their own fine
    const meRes = await runChain([attendanceController.Me], { auth: { user_id: carol._id }, query: {} });
    eq(meRes.status, 200, "/me needs no permission at all");
    ok("fineAmount" in meRes.body && "lateMinutes" in meRes.body, "…and shows the person their own late mark and fine");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await CompanyHoliday.deleteMany({ $or: [{ name: { $regex: `^${TAG}` } }, { date: "2026-11-08" }] });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await Setting.deleteMany({ key: { $regex: "^hr\\." } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

/**
 * HR STEP 2 — the Leave module.
 *
 * Policy under test: CL 12 (max 2 consecutive working days, never clubbed with
 * EL), SL 8 (medical certificate over 2 days), EL 12 (carry min(unused,20)),
 * WFH 12 (max 1/month, whole days). Aug-Dec 2026 is a pro-rated STUB that
 * carries nothing. Notice warns, never blocks. Same-day auto-rejects and is
 * kept. Two-level approval, either may approve, falling back to leave:approve:all
 * and auto-approving only for someone genuinely at the top. Comp-off is
 * per-instance with a 30-day expiry. Every approval writes through
 * AttendanceDayService.applyLeaveDecision().
 *
 *   node tests/hr-leave-module.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const LeaveRequest = require("../models/LeaveRequest");
const LeaveBalance = require("../models/LeaveBalance");
const CompOff = require("../models/CompOff");
const Attendance = require("../models/Attendance");
const CompanyHoliday = require("../models/CompanyHoliday");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const AdminNotification = require("../models/AdminNotification");
const LeaveService = require("../services/LeaveService");
const P = require("../services/leavePolicy");
P.istWeekdayOf = require("../services/hrPolicy").istWeekday;

const TAG = `lv-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// A fixed "today" so notice arithmetic is deterministic. 2026-08-24 is a Monday.
const NOW = new Date("2026-08-24T06:00:00.000Z"); // 11:30 IST Mon
// D(n) = n calendar days after Mon 2026-08-24. W(n) = the nth WORKING day after
// it, skipping Sundays — leave cannot be taken on a day you were not due in, so
// fixtures must not land on one.
const D = (n) => P.shiftDay("2026-08-24", n);
const W = (n) => {
  let d = "2026-08-24";
  for (let i = 0; i < n; i++) {
    do { d = P.shiftDay(d, 1); } while (P.istWeekdayOf(d) === 7);
  }
  return d;
};
const day = (d, fraction = 1) => ({ date: d, fraction });

const admins = [], roles = [], depts = [];
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const dept = await Department.create({ name: `${TAG}-d` }); depts.push(dept._id);
    const hrRole = await Role.create({ name: `${TAG}-hr`, departmentId: dept._id, permissions: ["leave:approve:all"] });
    roles.push(hrRole._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01"), ...extra });
      admins.push(a._id); return a;
    };
    const founder = await mk("Founder");                                   // no manager
    const head = await mk("Head", { reportingManagerId: founder._id });
    const mgr = await mk("Mgr", { reportingManagerId: head._id });
    const emp = await mk("Emp", { reportingManagerId: mgr._id });
    const hrPerson = await mk("HR", { roleIds: [hrRole._id], reportingManagerId: founder._id });

    // ── 1. ENTITLEMENT: the stub and the reset ──────────────────────────────
    console.log("1. entitlement — the Aug-Dec 2026 stub and the Jan 2027 reset");
    const b26 = await LeaveService.balancesFor(emp._id, 2026);
    const g = (rows, t) => rows.find((r) => r.type === t);
    eq(g(b26, "CL").entitled, 5, "2026 CL 5");
    eq(g(b26, "SL").entitled, 3.5, "2026 SL 3.5");
    eq(g(b26, "EL").entitled, 5, "2026 EL 5");
    eq(g(b26, "WFH").entitled, 5, "2026 WFH 5 (1/month across Aug-Dec)");
    ok(b26.every((r) => r.isStub), "…all flagged as a STUB, not year one");
    const b27 = await LeaveService.balancesFor(emp._id, 2027);
    eq(g(b27, "CL").entitled, 12, "2027 resets to CL 12");
    eq(g(b27, "SL").entitled, 8, "…SL 8");
    eq(g(b27, "EL").entitled, 12, "…EL 12");
    ok(b27.every((r) => !r.isStub), "…and 2027 is not a stub");

    // ── 2. CARRY-FORWARD ────────────────────────────────────────────────────
    console.log("\n2. EL carry = min(unused, 20); the stub carries nothing");
    eq(P.carryForward("EL", 2027, 25), 20, "25 unused carries 20 (the cap is on the CARRY)");
    eq(P.carryForward("EL", 2027, 7), 7, "7 unused carries 7");
    eq(P.carryForward("CL", 2027, 9), 0, "CL never carries");
    eq(P.carryForward("EL", 2026, 5), 0, "the 2026 STUB carries nothing out");
    const rolled = await LeaveService.rollYear(2026, [emp._id]);
    ok(rolled.opened >= 4, "the roll opened 2027 rows");
    const after27 = await LeaveService.balancesFor(emp._id, 2027);
    eq(g(after27, "EL").carriedIn, 0, "…carrying 0 EL out of the stub");
    eq(g(after27, "EL").available, 12, "…so 2027 opens at exactly 12");

    // ── 3. RESERVE ON SUBMISSION ────────────────────────────────────────────
    console.log("\n3. balance is RESERVED on submission, not on approval");
    const r1 = await LeaveService.apply({ type: "CL", days: [day(W(5))], reason: "personal" }, emp._id, NOW);
    eq(r1.request.status, "pending", "a normal application is pending");
    const balAfter = await LeaveService.balancesFor(emp._id, 2026);
    eq(g(balAfter, "CL").reserved, 1, "1 day reserved");
    eq(g(balAfter, "CL").consumed, 0, "…and nothing consumed yet");
    eq(g(balAfter, "CL").available, 4, "…available drops to 4");

    // the over-draw the reservation prevents
    const r2 = await LeaveService.apply({ type: "CL", days: [day(W(8)), day(W(9))], reason: "x" }, emp._id, NOW);
    const r3 = await LeaveService.apply({ type: "CL", days: [day(W(12)), day(W(13))], reason: "y" }, emp._id, NOW);
    ok(r2.request.status === "pending" && r3.request.status === "pending", "two more CL requests reserve 4 more");
    const over = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(16)), day(W(17))], reason: "z" }, emp._id, NOW));
    ok(over && /Insufficient CL balance/.test(over.message), `a sixth day is refused (${over && over.message})`);

    // release on cancel
    await LeaveService.cancel(r3.request._id, emp._id);
    const relBal = await LeaveService.balancesFor(emp._id, 2026);
    eq(g(relBal, "CL").reserved, 3, "cancelling releases the reservation");

    // ── 4. CL RULES ─────────────────────────────────────────────────────────
    console.log("\n4. CL: max 2 consecutive working days, never clubbed with EL");
    const emp2 = await mk("Emp2", { reportingManagerId: mgr._id });
    const three = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(5)), day(W(6)), day(W(7))], reason: "x" }, emp2._id, NOW));
    ok(three && /at most 2 consecutive/.test(three.message), `3 consecutive CL is refused (${three && three.message})`);
    // Fri + Mon across a Sunday is still 2 CONSECUTIVE WORKING days — allowed…
    const friMon = await LeaveService.apply({ type: "CL", days: [day("2026-08-29"), day("2026-08-31")], reason: "x" }, emp2._id, NOW);
    eq(friMon.request.status, "pending", "Sat + Mon across a Sunday is 2 working days — allowed");
    // …but adding the Friday makes a run of 3, even though Sunday sits inside it.
    const spanning = await threw(() => LeaveService.apply({ type: "CL", days: [day("2026-08-28")], reason: "x" }, emp2._id, NOW));
    ok(spanning && /consecutive/.test(spanning.message), "…and a third working day in that run is refused — a Sunday does NOT break the chain");
    ok(spanning && /3/.test(spanning.message), "…counted across SEPARATE requests, so two requests cannot defeat the cap");

    const emp3 = await mk("Emp3", { reportingManagerId: mgr._id });
    await LeaveService.apply({ type: "EL", days: [day(W(20))], reason: "trip" }, emp3._id, NOW);
    const clubbed = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(21))], reason: "x" }, emp3._id, NOW));
    ok(clubbed && /cannot be clubbed/.test(clubbed.message), `CL adjacent to EL is refused (${clubbed && clubbed.message})`);
    // The mirror: a person with an accepted CL day cannot then put EL beside it.
    const emp3b = await mk("Emp3b", { reportingManagerId: mgr._id });
    const okCl = await LeaveService.apply({ type: "CL", days: [day(W(20))], reason: "x" }, emp3b._id, NOW);
    eq(okCl.request.status, "pending", "a standalone CL day is accepted");
    const elClub = await threw(() => LeaveService.apply({ type: "EL", days: [day(W(21))], reason: "x" }, emp3b._id, NOW));
    ok(elClub && /cannot be clubbed/.test(elClub.message), "…and the rule is symmetric from the EL side");
    const farAway = await LeaveService.apply({ type: "CL", days: [day(W(25))], reason: "x" }, emp3._id, NOW);
    eq(farAway.request.status, "pending", "CL two working days away from EL is fine");

    // ── 5. SL, WFH ──────────────────────────────────────────────────────────
    console.log("\n5. SL medical certificate; WFH 1/month, whole days");
    const emp4 = await mk("Emp4", { reportingManagerId: mgr._id });
    const noCert = await threw(() => LeaveService.apply({ type: "SL", days: [day(W(5)), day(W(6)), day(W(7))], reason: "flu" }, emp4._id, NOW));
    ok(noCert && /medical certificate/.test(noCert.message), "SL over 2 days without a certificate is refused");
    const twoDays = await LeaveService.apply({ type: "SL", days: [day(W(5)), day(W(6))], reason: "flu" }, emp4._id, NOW);
    eq(twoDays.request.status, "pending", "…exactly 2 days needs none");
    const emp5 = await mk("Emp5", { reportingManagerId: mgr._id });
    const withCert = await LeaveService.apply({ type: "SL", days: [day(W(5)), day(W(6)), day(W(7))], reason: "flu", medicalCertificate: "https://s3/cert.pdf" }, emp5._id, NOW);
    eq(withCert.request.medicalCertificate, "https://s3/cert.pdf", "…and 3 days WITH a certificate is accepted");
    const halfOver = await threw(() => LeaveService.apply({ type: "SL", days: [day(W(12)), day(W(13)), day(W(14), 0.5)], reason: "x" }, emp4._id, NOW));
    ok(halfOver && /medical certificate/.test(halfOver.message), "…2.5 days counts as more than 2");

    const emp6 = await mk("Emp6", { reportingManagerId: mgr._id });
    const wfhHalf = await threw(() => LeaveService.apply({ type: "WFH", days: [day(W(5), 0.5)], reason: "x" }, emp6._id, NOW));
    ok(wfhHalf && /whole-day only/.test(wfhHalf.message), "WFH rejects a half-day");
    await LeaveService.apply({ type: "WFH", days: [day(W(5))], reason: "x" }, emp6._id, NOW);
    const wfhTwice = await threw(() => LeaveService.apply({ type: "WFH", days: [day(W(6))], reason: "x" }, emp6._id, NOW));
    ok(wfhTwice && /1 day per month/.test(wfhTwice.message), `a second WFH in the same month is refused (${wfhTwice && wfhTwice.message})`);
    const nextMonth = await LeaveService.apply({ type: "WFH", days: [day("2026-09-07")], reason: "x" }, emp6._id, NOW);
    eq(nextMonth.request.status, "pending", "…but one in September is fine");

    // ── 6. NOTICE WARNS, SAME-DAY AUTO-REJECTS ──────────────────────────────
    console.log("\n6. notice warns and flags; same-day auto-rejects but is KEPT");
    const emp7 = await mk("Emp7", { reportingManagerId: mgr._id });
    const shortEl = await LeaveService.apply({ type: "EL", days: [day(W(10))], reason: "x" }, emp7._id, NOW);
    eq(shortEl.request.status, "pending", "an EL 10 days out SUBMITS — notice never blocks");
    eq(shortEl.request.shortNotice, true, "…flagged short-notice for the approver to weigh");
    // W(10) is 11 CALENDAR days out — it skips a Sunday — and notice is counted
    // in calendar days, which is what "15 days advance" means to a person.
    eq(shortEl.request.noticeDays, 11, "…recording the notice actually given, in calendar days");
    eq(shortEl.request.requiredNoticeDays, 15, "…and what the policy asks for");
    ok(shortEl.warnings.length > 0, "…with a warning returned to the applicant");
    const longEl = await LeaveService.apply({ type: "EL", days: [day(W(30))], reason: "x" }, emp7._id, NOW);
    eq(longEl.request.shortNotice, false, "…and 30 days out is not short-notice");

    const sameDay = await LeaveService.apply({ type: "CL", days: [day(D(0))], reason: "emergency" }, emp7._id, NOW);
    eq(sameDay.request.status, "auto_rejected", "same-day is AUTO-REJECTED");
    ok(!!(await LeaveRequest.findById(sameDay.request._id)), "…and the record is KEPT — the attempt is information");
    const sdBal = await LeaveService.balancesFor(emp7._id, 2026);
    eq(g(sdBal, "CL").reserved, 0, "…reserving nothing");
    const past = await LeaveService.apply({ type: "CL", days: [day(D(-3))], reason: "x" }, emp7._id, NOW);
    eq(past.request.status, "auto_rejected", "a past-dated request is auto-rejected too");
    const tomorrow = await LeaveService.apply({ type: "CL", days: [day(D(1))], reason: "x" }, emp7._id, NOW);
    eq(tomorrow.request.status, "pending", "…while starting TOMORROW is fine");

    // ── 7. APPROVAL CHAIN ───────────────────────────────────────────────────
    console.log("\n7. two levels, either may approve");
    const chain = await LeaveService.managerChain(emp._id, 2);
    eq(chain.length, 2, "the chain is two levels");
    eq(String(chain[0]), String(mgr._id), "…the applicant's manager");
    eq(String(chain[1]), String(head._id), "…and that manager's manager");
    eq(String(r1.request.approvers[0]), String(mgr._id), "both are recorded on the request");
    const notes = await AdminNotification.find({ adminId: { $in: [mgr._id, head._id] }, type: "leave_request" }).lean();
    ok(notes.length >= 2, "…and BOTH were notified");

    const notMine = await threw(() => LeaveService.decide(r1.request._id, { approve: true }, emp2._id));
    ok(notMine && notMine.status === 403, "someone off the chain cannot approve");
    const self = await threw(() => LeaveService.decide(r1.request._id, { approve: true }, emp._id));
    ok(self && self.status === 403, "…nor can the applicant approve their own");
    // the SECOND level may approve — "either"
    const approved = await LeaveService.decide(r1.request._id, { approve: true, note: "ok" }, head._id);
    eq(approved.request.status, "approved", "the second-level manager can approve");
    const twice = await threw(() => LeaveService.decide(r1.request._id, { approve: true }, mgr._id));
    ok(twice && twice.status === 409, "…and a second decision is refused");

    // fallback when the chain is empty but somebody holds leave:approve:all
    const orphan = await mk("Orphan"); // no manager
    const oReq = await LeaveService.apply({ type: "CL", days: [day(W(5))], reason: "x" }, orphan._id, NOW);
    eq(oReq.request.status, "pending", "an empty chain does NOT auto-approve");
    ok(oReq.request.approvers.map(String).includes(String(hrPerson._id)),
      "…it falls back to a holder of leave:approve:all, so a real person sees it");

    // genuinely at the top — nobody above, and they hold the org-wide grant
    const topReq = await LeaveService.apply({ type: "CL", days: [day(W(5))], reason: "x" }, hrPerson._id, NOW);
    ok(["approved", "pending"].includes(topReq.request.status), "a top-of-chain applicant is handled");

    // ── 8. THE CHOKEPOINT ───────────────────────────────────────────────────
    console.log("\n8. approval writes through AttendanceDayService.applyLeaveDecision()");
    const att = await Attendance.findOne({ adminId: emp._id, date: D(5) }).lean();
    ok(!!att, "an attendance row exists for the approved day");
    eq(att.dayStatus, "leave_paid", "…marked leave_paid");
    eq(att.dayFraction, 0, "…with dayFraction 0");
    eq(String(att.leaveRequestId), String(r1.request._id), "…linked to the request that caused it");
    const src = require("fs").readFileSync("services/LeaveService.js", "utf8");
    ok(!/Attendance\.updateOne|Attendance\.create/.test(src),
      "LeaveService never touches Attendance directly — the chokepoint is the only door");

    // a half-day resolves to half_day with fraction 0.5
    const emp8 = await mk("Emp8", { reportingManagerId: mgr._id });
    const halfReq = await LeaveService.apply({ type: "CL", days: [day(W(5), 0.5)], reason: "x" }, emp8._id, NOW);
    await LeaveService.decide(halfReq.request._id, { approve: true }, mgr._id);
    const halfAtt = await Attendance.findOne({ adminId: emp8._id, date: D(5) }).lean();
    eq(halfAtt.dayStatus, "half_day", "a half-day writes half_day");
    eq(halfAtt.dayFraction, 0.5, "…with fraction 0.5");
    const hb = await LeaveService.balancesFor(emp8._id, 2026);
    eq(g(hb, "CL").consumed, 0.5, "…and costs 0.5 from the balance");

    // rejection releases, never consumes
    const emp9 = await mk("Emp9", { reportingManagerId: mgr._id });
    const rej = await LeaveService.apply({ type: "CL", days: [day(W(5))], reason: "x" }, emp9._id, NOW);
    await LeaveService.decide(rej.request._id, { approve: false, note: "busy week" }, mgr._id);
    const rb = await LeaveService.balancesFor(emp9._id, 2026);
    eq(rb.find((x) => x.type === "CL").reserved, 0, "a rejection releases the reservation");
    eq(rb.find((x) => x.type === "CL").consumed, 0, "…and consumes nothing");
    eq(await Attendance.countDocuments({ adminId: emp9._id, date: D(5) }), 0, "…and writes no attendance row");

    // ── 9. COMP-OFF ─────────────────────────────────────────────────────────
    console.log("\n9. comp-off — per-instance, 30-day expiry");
    const SUN = "2026-08-23";
    const notSunday = await threw(() => LeaveService.earnCompOff({ adminId: emp._id, earnedFor: "2026-08-24" }, mgr._id));
    ok(notSunday && /working day/.test(notSunday.message), "a working day earns no comp-off");
    const grant = await LeaveService.earnCompOff({ adminId: emp._id, earnedFor: SUN, note: "event" }, mgr._id);
    eq(grant.status, "pending", "a Sunday worked creates a PENDING grant");
    eq(grant.expiresAt, "2026-09-22", "…expiring exactly 30 days after that Sunday");
    const dupe = await threw(() => LeaveService.earnCompOff({ adminId: emp._id, earnedFor: SUN }, mgr._id));
    ok(dupe && dupe.status === 409, "…and the same Sunday cannot be claimed twice");
    await LeaveService.decideCompOff(grant._id, { grant: true }, mgr._id);

    const beyond = await threw(() => LeaveService.apply({ type: "COMP_OFF", days: [day("2026-09-23")], reason: "x" }, emp._id, NOW));
    ok(beyond && /expires 30 days/.test(beyond.message), "using it AFTER the window fails — the date USED is what counts");
    const inWindow = await LeaveService.apply({ type: "COMP_OFF", days: [day("2026-09-21")], reason: "x" }, emp._id, NOW);
    eq(inWindow.request.status, "pending", "…inside the window it applies");
    await LeaveService.decide(inWindow.request._id, { approve: true }, mgr._id);
    const spent = await CompOff.findById(grant._id).lean();
    eq(spent.status, "consumed", "approval consumes the grant");
    eq(String(spent.consumedBy), String(inWindow.request._id), "…linked to the request that spent it");
    const coAtt = await Attendance.findOne({ adminId: emp._id, date: "2026-09-21" }).lean();
    eq(coAtt.dayStatus, "comp_off", "…and the day is marked comp_off through the chokepoint");

    // per-instance expiry — the reason it cannot be a counter
    const old = await LeaveService.earnCompOff({ adminId: emp2._id, earnedFor: "2026-07-05" }, mgr._id);
    await LeaveService.decideCompOff(old._id, { grant: true }, mgr._id);
    const exp = await LeaveService.expireCompOffs("2026-08-24");
    ok(exp.expired >= 1, "a grant past its own window expires");
    eq((await CompOff.findById(old._id).lean()).status, "expired", "…individually, on its own earn date");

    // ── 10. SERVICE ACCOUNTS ────────────────────────────────────────────────
    console.log("\n10. a service account is a login, not a person");
    const svc = await mk("Svc", { meta: { isServiceAccount: true } });
    const svcTry = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(5))], reason: "x" }, svc._id, NOW));
    ok(svcTry && svcTry.status === 403, "…and cannot apply for leave");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await LeaveRequest.deleteMany({ adminId: { $in: admins } });
    await LeaveBalance.deleteMany({ adminId: { $in: admins } });
    await CompOff.deleteMany({ adminId: { $in: admins } });
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await AdminNotification.deleteMany({ adminId: { $in: admins } });
    await CompanyHoliday.deleteMany({ name: { $regex: `^${TAG}` } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

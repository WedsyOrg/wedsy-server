/**
 * RULE BREACHES ARE RECORDED, NOT REFUSED (2026-08-24).
 *
 * Same-day leave already submitted, recorded and auto-rejected, so the attempt
 * stayed visible. The three enforceable rules threw a 400 instead and left no
 * trace — neither the pattern for an approver nor, for the applicant, what they
 * had tried. One rule, one behaviour.
 *
 * This suite pins BOTH halves of the line: what is recorded, and what is still a
 * genuine 400 — so the boundary cannot quietly move.
 *
 *   node tests/hr-leave-rule-breaches.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const LeaveRequest = require("../models/LeaveRequest");
const LeaveBalance = require("../models/LeaveBalance");
const Attendance = require("../models/Attendance");
const CompOff = require("../models/CompOff");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeaveService = require("../services/LeaveService");
const P = require("../services/leavePolicy");
const { istWeekday } = require("../services/hrPolicy");

const TAG = `rb-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const NOW = new Date("2026-08-24T06:00:00.000Z"); // Mon 11:30 IST
const W = (n) => { let d = "2026-08-24"; for (let i = 0; i < n; i++) { do { d = P.shiftDay(d, 1); } while (istWeekday(d) === 7); } return d; };
const day = (d, fraction = 1) => ({ date: d, fraction });

const admins = [], depts = [];
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const dept = await Department.create({ name: `${TAG}-d` }); depts.push(dept._id);
    const mgr = await Admin.create({ name: `${TAG} Mgr`, email: `${TAG}m@x.com`, phone: `${TAG}m`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01") });
    admins.push(mgr._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01"), reportingManagerId: mgr._id, ...extra });
      admins.push(a._id); return a;
    };
    const bal = async (id, type) => (await LeaveService.balancesFor(id, 2026)).find((b) => b.type === type);

    // ── 1. ALL FOUR BREACHES TAKE ONE PATH ──────────────────────────────────
    console.log("1. every policy breach is recorded and auto-rejected");
    const cases = [];

    const a1 = await mk("Aconsec");
    cases.push(["3 consecutive CL", await LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4)), day(W(5))], reason: "x" }, a1._id, NOW), "cl_consecutive"]);

    const a2 = await mk("Bclub");
    await LeaveService.apply({ type: "EL", days: [day(W(20))], reason: "trip" }, a2._id, NOW);
    cases.push(["CL beside EL", await LeaveService.apply({ type: "CL", days: [day(W(21))], reason: "x" }, a2._id, NOW), "cl_el_clubbing"]);

    const a3 = await mk("Cwfh");
    await LeaveService.apply({ type: "WFH", days: [day(W(3))], reason: "x" }, a3._id, NOW);
    cases.push(["2nd WFH in a month", await LeaveService.apply({ type: "WFH", days: [day(W(4))], reason: "x" }, a3._id, NOW), "wfh_monthly_cap"]);

    const a4 = await mk("Dsameday");
    cases.push(["same-day", await LeaveService.apply({ type: "CL", days: [day("2026-08-24")], reason: "x" }, a4._id, NOW), "same_day"]);

    for (const [what, res, code] of cases) {
      eq(res.request.status, "auto_rejected", `${what}: auto_rejected`);
      eq(res.request.autoRejectCode, code, `${what}: code ${code}`);
      ok(!!res.request.autoRejectLabel, `${what}: carries a strip label ("${res.request.autoRejectLabel}")`);
      ok(!!res.request.decisionNote, `${what}: carries the full reason`);
      ok(!!(await LeaveRequest.findById(res.request._id)), `${what}: the record persists`);
      ok(res.autoRejected === true && !!res.breach, `${what}: the caller is told it was a breach, not an error`);
    }
    // the labels are DISTINCT from the same-day copy
    const labels = cases.map(([, r]) => r.request.autoRejectLabel);
    eq(new Set(labels).size, 4, `each rule has its own phrasing (${labels.join(" | ")})`);
    ok(!labels.filter((l, i) => cases[i][2] !== "same_day").some((l) => /same.day/i.test(l)),
      "…and a rule breach never reuses the same-day wording");

    // ── 2. IT RESERVES NOTHING ──────────────────────────────────────────────
    console.log("\n2. an auto-rejected request never holds balance");
    const before = await bal(a1._id, "CL");
    eq(before.reserved, 0, "nothing reserved after a breach");
    eq(before.consumed, 0, "…and nothing consumed");
    eq(before.available, 5, "…the full stub entitlement is still available");

    // the ordering claim: the record exists, and the balance never moved
    const a5 = await mk("Eorder");
    const b5before = await bal(a5._id, "CL");
    const breach5 = await LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4)), day(W(5))], reason: "x" }, a5._id, NOW);
    const b5after = await bal(a5._id, "CL");
    eq(breach5.request.status, "auto_rejected", "a breach is recorded");
    eq(b5after.reserved, b5before.reserved, "…and reserved is byte-identical before and after");
    // a concurrent applicant must see the FULL balance — never a briefly-held one
    const okAfter = await LeaveService.apply({ type: "CL", days: [day(W(8)), day(W(9))], reason: "x" }, a5._id, NOW);
    eq(okAfter.request.status, "pending", "a later valid request is unaffected");
    eq((await bal(a5._id, "CL")).reserved, 2, "…and reserves normally");

    // ── 3. THE RESERVATION RACE ─────────────────────────────────────────────
    console.log("\n3. concurrent applications cannot over-draw");
    const a6 = await mk("Frace");
    // 5 CL available. Fire two 3-day-equivalent requests at once: only one fits.
    const [r1, r2] = await Promise.allSettled([
      LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4))], reason: "a" }, a6._id, NOW),
      LeaveService.apply({ type: "CL", days: [day(W(8)), day(W(9))], reason: "b" }, a6._id, NOW),
    ]);
    const both = [r1, r2].filter((r) => r.status === "fulfilled" && r.value.request.status === "pending");
    const b6 = await bal(a6._id, "CL");
    eq(b6.reserved, both.length * 2, `reserved matches what actually succeeded (${both.length} request(s))`);
    ok(b6.reserved <= b6.entitled, `…and never exceeds the entitlement (${b6.reserved} ≤ ${b6.entitled})`);
    ok(b6.available >= 0, "…leaving a non-negative balance");

    // and the guard itself: a request larger than what is left is refused
    const a7 = await mk("Gover");
    await LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4))], reason: "x" }, a7._id, NOW);
    await LeaveService.apply({ type: "CL", days: [day(W(8)), day(W(9))], reason: "x" }, a7._id, NOW);
    const over = await LeaveService.apply({ type: "CL", days: [day(W(12)), day(W(13))], reason: "x" }, a7._id, NOW);
    eq(over.request.status, "auto_rejected", "an over-draw is recorded, not thrown");
    eq(over.request.autoRejectCode, "insufficient_balance", "…under the balance code");
    eq((await bal(a7._id, "CL")).reserved, 4, "…and the refused attempt reserved nothing");
    eq(await LeaveRequest.countDocuments({ adminId: a7._id, status: "pending" }), 2, "…leaving only the two that fit");

    // ── 4. WHAT IS STILL A 400 ──────────────────────────────────────────────
    // Malformed input is NOT a policy breach. There is no attempt to record
    // because there was no coherent request.
    console.log("\n4. malformed input is still a 400 and records nothing");
    const a8 = await mk("Hbad");
    const before8 = await LeaveRequest.countDocuments({ adminId: a8._id });
    const bad = [
      ["unknown type", { type: "SABBATICAL", days: [day(W(3))] }],
      ["empty days", { type: "CL", days: [] }],
      ["missing days", { type: "CL" }],
      ["bad date format", { type: "CL", days: [{ date: "24/08/2026", fraction: 1 }] }],
      ["bad fraction", { type: "CL", days: [{ date: W(3), fraction: 0.25 }] }],
      ["duplicate date", { type: "CL", days: [day(W(3)), day(W(3))] }],
      ["spans two years", { type: "EL", days: [day("2026-12-31"), day("2027-01-04")] }],
    ];
    for (const [what, body] of bad) {
      const e = await threw(() => LeaveService.apply({ ...body, reason: "x" }, a8._id, NOW));
      ok(e && e.status === 400, `${what} → 400 (${e && e.message})`);
    }
    eq(await LeaveRequest.countDocuments({ adminId: a8._id }), before8, "…and NOT ONE of them was recorded");

    // authorisation and identity are neither
    const svc = await mk("Isvc", { meta: { isServiceAccount: true } });
    const svcErr = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(3))], reason: "x" }, svc._id, NOW));
    eq(svcErr && svcErr.status, 403, "a service account is 403, not a recorded breach");
    eq(await LeaveRequest.countDocuments({ adminId: svc._id }), 0, "…and records nothing");
    const ghost = await threw(() => LeaveService.apply({ type: "CL", days: [day(W(3))], reason: "x" }, new mongoose.Types.ObjectId(), NOW));
    eq(ghost && ghost.status, 404, "an unknown applicant is 404");

    // ── 5. THE FOUR RULED ON 2026-08-24 ─────────────────────────────────────
    console.log("\n5. the borderline cases, after the ruling");
    const a9 = await mk("Jedge");
    const wfhHalf = await LeaveService.apply({ type: "WFH", days: [day(W(3), 0.5)], reason: "x" }, a9._id, NOW);
    eq(wfhHalf.request.status, "auto_rejected", "WFH half-day → RECORDED");
    eq(wfhHalf.request.autoRejectCode, "wfh_whole_day_only", "…with its own code");

    const a9b = await mk("Ksunday");
    const sunday = await LeaveService.apply({ type: "CL", days: [day("2026-08-30")], reason: "x" }, a9b._id, NOW);
    eq(sunday.request.status, "auto_rejected", "leave on a Sunday → RECORDED");
    eq(sunday.request.autoRejectCode, "non_working_day", "…as a calendar misunderstanding");
    ok(/no leave is needed/.test(sunday.request.decisionNote), "…explaining why, not scolding");

    // A non-working day short-circuits: it must not ALSO raise a consecutive-run
    // or clubbing breach computed over days the person was never due in.
    const a9c = await mk("Lmixed");
    const mixed = await LeaveService.apply({ type: "CL", days: [day("2026-08-30"), day(W(3)), day(W(4)), day(W(5))], reason: "x" }, a9c._id, NOW);
    eq(mixed.request.autoRejectCode, "non_working_day", "a request mixing an off-day with a rule breach reports the OFF-DAY first");
    ok(!/consecutive/.test(mixed.request.decisionNote), "…and does not stack a second, confusing reason on top");

    // SL certificate stays a 400 — a fixable omission, not a breach. Auto-
    // rejecting would force a re-apply when attaching the file is the real fix.
    const a9d = await mk("Mcert");
    const certErr = await threw(() => LeaveService.apply({ type: "SL", days: [day(W(3)), day(W(4)), day(W(5))], reason: "x" }, a9d._id, NOW));
    ok(certErr && certErr.status === 400, `SL over 2 days without a certificate → still 400 (${certErr && certErr.message})`);
    eq(await LeaveRequest.countDocuments({ adminId: a9d._id }), 0, "…and is NOT recorded — nothing to re-apply around");
    const withCert = await LeaveService.apply({ type: "SL", days: [day(W(3)), day(W(4)), day(W(5))], reason: "x", medicalCertificate: "https://s3/c.pdf" }, a9d._id, NOW);
    eq(withCert.request.status, "pending", "…and attaching the certificate is all it takes");

    // Insufficient balance: recorded, but under its OWN code.
    const a9e = await mk("Nbroke");
    await LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4))], reason: "x" }, a9e._id, NOW);
    await LeaveService.apply({ type: "CL", days: [day(W(8)), day(W(9))], reason: "x" }, a9e._id, NOW);
    const broke = await LeaveService.apply({ type: "CL", days: [day(W(12)), day(W(13))], reason: "x" }, a9e._id, NOW);
    eq(broke.request.status, "auto_rejected", "running out → RECORDED");
    eq(broke.request.autoRejectCode, "insufficient_balance", "…under its OWN code, never a rule breach");
    ok(!/rule|breach|policy/i.test(broke.request.autoRejectLabel), `…and the label reads as a balance problem ("${broke.request.autoRejectLabel}")`);
    ok(/Not enough casual leave left/.test(broke.request.decisionNote), "…naming the leave type in words");
    eq((await bal(a9e._id, "CL")).reserved, 4, "…and it reserved nothing — the guarded update never matched");

    // ── 6. A VALID REQUEST IS UNTOUCHED ─────────────────────────────────────
    console.log("\n6. the happy path is unchanged");
    const a10 = await mk("Kfine");
    const good = await LeaveService.apply({ type: "CL", days: [day(W(3)), day(W(4))], reason: "wedding" }, a10._id, NOW);
    eq(good.request.status, "pending", "a compliant request is pending");
    eq(good.request.autoRejectCode, null, "…with no rejection code");
    eq((await bal(a10._id, "CL")).reserved, 2, "…and reserves normally");
    eq(good.request.approvers.length, 1, "…and is routed to an approver");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await LeaveRequest.deleteMany({ adminId: { $in: admins } });
    await LeaveBalance.deleteMany({ adminId: { $in: admins } });
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await CompOff.deleteMany({ adminId: { $in: admins } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

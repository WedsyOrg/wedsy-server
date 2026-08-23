/**
 * HR STEP 3 — the monthly payable sheet.
 *
 * Turns attendance and leave into money. OS owns Rohaan's policy (late fines,
 * LOP, leave, comp-off); Razorpay owns tax law. Nothing statutory here.
 *
 * Key rules under test: a day's pay is gross/30 FIXED (matching Razorpay's
 * default LOP basis), salary is effective-dated so a finalised month never
 * moves, LOP and fines are PROPOSED and deduct nothing until a founder acts,
 * waived is a distinct state that consumes no leave, finalising RECOMPUTES then
 * freezes, and it is blocked while anything is unactioned or missing a salary.
 *
 *   node tests/hr-payroll-sheet.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const PayrollRun = require("../models/PayrollRun");
const EmployeeSalary = require("../models/EmployeeSalary");
const Attendance = require("../models/Attendance");
const LeaveRequest = require("../models/LeaveRequest");
const LeaveBalance = require("../models/LeaveBalance");
const CompOff = require("../models/CompOff");
const CompanyHoliday = require("../models/CompanyHoliday");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const PayrollService = require("../services/PayrollService");
const PayrollExportService = require("../services/PayrollExportService");
const P = require("../services/payrollPolicy");
const { requirePermission } = require("../middlewares/requirePermission");
const { validatePermissions } = require("../utils/rbacPermissions");
const controller = require("../controllers/payroll");

const TAG = `pr-${Date.now()}`;
const MONTH = "2026-09";           // 30 calendar days
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const lineFor = (sheet, id) => sheet.lines.find((l) => String(l.adminId) === String(id));

const runChain = (handlers, req) =>
  new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, send(b) { resolve({ status: this.statusCode, body: b }); }, json(b) { resolve({ status: this.statusCode, body: b }); }, setHeader() {} };
    let i = 0;
    const next = () => { const h = handlers[i++]; if (!h) return resolve({ status: res.statusCode, body: null }); Promise.resolve(h(req, res, next)).catch((e) => resolve({ status: 500, body: { message: e.message } })); };
    next();
  });

const admins = [], roles = [], depts = [];
// The dev database carries 140+ leftover test admins from other suites, every
// one of them without a salary record — so an unscoped run is (correctly)
// blocked by them. Scope this suite's runs to its own people.
const SCOPE = () => ({ adminIds: admins });
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    await PayrollRun.deleteOne({ month: MONTH });
    const dept = await Department.create({ name: `${TAG}-d` }); depts.push(dept._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01"), ...extra });
      admins.push(a._id); return a;
    };
    const clean = await mk("Aclean");     // perfect month
    const messy = await mk("Bmessy");     // LOP + fines + incomplete
    const noSal = await mk("Cnosalary");  // blocking
    const joiner = await mk("Djoiner", { joinedAt: new Date("2026-09-10") });
    const unknown = await mk("Eunknown", { joinedAt: null });
    const svc = await mk("Fservice", { meta: { isServiceAccount: true } });

    const CTC = 720000; // → ₹60,000/month → ₹2,000/day at /30
    for (const a of [clean, messy, joiner, unknown]) {
      await PayrollService.setSalary({ adminId: a._id, annualCtc: CTC, effectiveFrom: "2025-01-01" }, clean._id);
    }

    // ── 1. THE DIVISOR ──────────────────────────────────────────────────────
    console.log("1. a day's pay is gross/30, fixed");
    eq(P.DAY_DIVISOR, 30, "divisor is 30");
    eq(P.dayRate(60000), 2000, "₹60,000 gross → ₹2,000/day");
    for (const m of ["2026-02", "2026-08", "2026-09", "2026-11"]) {
      eq(P.dayRate(P.monthlyGross(CTC)), 2000, `…identical in ${m} (${P.daysInMonth(m)} days) — matches Razorpay's basis`);
    }

    // ── 2. EFFECTIVE-DATED SALARY ───────────────────────────────────────────
    console.log("\n2. salary is effective-dated — a raise never moves a past month");
    await PayrollService.setSalary({ adminId: clean._id, annualCtc: 960000, effectiveFrom: "2026-10-15", note: "raise" }, clean._id);
    const hist = await PayrollService.salaryHistory(clean._id);
    eq(hist.length, 2, "two salary records");
    eq(P.governingSalary(hist, "2026-09").annualCtc, 720000, "September uses the OLD figure");
    eq(P.governingSalary(hist, "2026-10").annualCtc, 720000, "…October too — the raise is dated the 15th");
    eq(P.governingSalary(hist, "2026-11").annualCtc, 960000, "…and November uses the new one");

    // ── 3. THE SHEET ────────────────────────────────────────────────────────
    console.log("\n3. the sheet");
    // messy: 1 unexplained absence, 1 same-day rejection, 2 late fines, 1 incomplete
    const A = (adminId, date, extra) => Attendance.create({ adminId, date, checkInAt: new Date(`${date}T05:30:00Z`), ...extra });
    await A(messy._id, "2026-09-01", { dayStatus: "present", checkOutAt: new Date("2026-09-01T13:30:00Z"), closure: { by: "self" } });
    await A(messy._id, "2026-09-02", { dayStatus: "absent_unexplained", dayFraction: 0, closure: { by: "system", reason: "no_attendance_recorded" } });
    await A(messy._id, "2026-09-03", { dayStatus: "incomplete", closure: { by: "system", reason: "no_checkout" } });
    await A(messy._id, "2026-09-04", { dayStatus: "present", lateMinutes: 35, fineAmount: 300, policySnapshot: { workStartTime: "11:00", graceMinutes: 20, lateBands: [{ toMinutes: 60, fine: 300 }, { toMinutes: null, fine: 500 }], source: "company" } });
    await A(messy._id, "2026-09-07", { dayStatus: "present", lateMinutes: 75, fineAmount: 500, policySnapshot: { workStartTime: "11:00", graceMinutes: 20, lateBands: [{ toMinutes: 60, fine: 300 }, { toMinutes: null, fine: 500 }], source: "company" } });
    await A(messy._id, "2026-09-08", { dayStatus: "absent_unexplained", dayFraction: 0 });
    // A second incomplete day that is deliberately never converted, so the
    // "unactioned incomplete is PAID" case survives into the frozen snapshot and
    // the export. Incomplete days do not block finalisation, by design.
    await A(messy._id, "2026-09-10", { dayStatus: "incomplete", closure: { by: "system", reason: "no_checkout" } });
    await LeaveRequest.create({ adminId: messy._id, type: "CL", days: [{ date: "2026-09-08", fraction: 1 }], totalDays: 1, status: "auto_rejected", decisionNote: "same-day" });
    await A(clean._id, "2026-09-01", { dayStatus: "present", closure: { by: "self" } });

    const { sheet } = await PayrollService.getSheet(MONTH, clean._id, SCOPE());
    const mLine = lineFor(sheet, messy._id);
    eq(sheet.dayDivisor, 30, "the run records its divisor");
    eq(sheet.daysInMonth, 30, "…and the month length");
    ok(sheet.workingDaysInMonth > 0, `…and working days as CONTEXT (${sheet.workingDaysInMonth}), not the divisor`);
    eq(mLine.payableGross, 60000, "gross = CTC/12");
    eq(mLine.dayRate, 2000, "day rate = gross/30");
    eq(mLine.present, 3, "days present counted");
    eq(mLine.incompleteDays.length, 2, "incomplete days surfaced");
    eq(mLine.lateInstances, 2, "two late instances");
    eq(mLine.items.filter((i) => i.kind === "lop").length, 2, "two LOP days proposed");
    const srcs = mLine.items.filter((i) => i.kind === "lop").map((i) => i.source).sort();
    eq(JSON.stringify(srcs), JSON.stringify(["absent_unexplained", "same_day_rejection"]),
      "…each carrying WHERE IT CAME FROM");

    // ── 4. NOTHING DEDUCTS UNTIL A FOUNDER ACTS ─────────────────────────────
    console.log("\n4. LOP and fines are PROPOSED — nothing deducts until actioned");
    eq(mLine.lopDeduction, 0, "no LOP deducted while pending");
    eq(mLine.fineDeduction, 0, "no fine deducted while pending");
    eq(mLine.totalDeductions, 0, "…so nothing is deducted at all");
    eq(mLine.netBeforeStatutory, 60000, "…and net = gross");
    ok(mLine.items.every((i) => i.status === "pending"), "every proposal starts pending");
    ok(mLine.blocking.some((b) => /not yet approved or waived/.test(b)), "…and the line is flagged blocking");

    // approve one LOP day
    await PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "lop", date: "2026-09-02", action: "approve", reason: "no contact" }, clean._id, SCOPE());
    let s2 = (await PayrollService.getSheet(MONTH, clean._id, SCOPE())).sheet;
    let m2 = lineFor(s2, messy._id);
    eq(m2.lopDeduction, 2000, "approving one LOP day deducts exactly one day's pay");
    eq(m2.lopDays, 1, "…counted as 1 LOP day");
    eq(m2.netBeforeStatutory, 58000, "…and net drops by ₹2,000");

    // ── 5. WAIVED IS A DISTINCT STATE ───────────────────────────────────────
    console.log("\n5. waived deducts nothing and consumes no leave");
    const balBefore = await LeaveBalance.find({ adminId: messy._id }).lean();
    await PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "lop", date: "2026-09-08", action: "waive", reason: "family emergency, informed by phone" }, clean._id, SCOPE());
    await PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "fine", date: "2026-09-04", action: "waive", reason: "traffic — city-wide" }, clean._id, SCOPE());
    await PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "fine", date: "2026-09-07", action: "approve", reason: "" }, clean._id, SCOPE());
    s2 = (await PayrollService.getSheet(MONTH, clean._id, SCOPE())).sheet;
    m2 = lineFor(s2, messy._id);
    eq(m2.lopDeduction, 2000, "the waived LOP day is NOT deducted");
    eq(m2.fineDeduction, 500, "the waived fine is NOT deducted; the approved one is");
    eq(m2.waivedCount, 2, "…and both remain visible as waived");
    const waived = m2.items.find((i) => i.date === "2026-09-08" && i.kind === "lop");
    eq(waived.status, "waived", "waived is a DISTINCT status, not a silent zero");
    eq(waived.reason, "family emergency, informed by phone", "…carrying its reason");
    const balAfter = await LeaveBalance.find({ adminId: messy._id }).lean();
    eq(JSON.stringify(balAfter.map((b) => b.consumed)), JSON.stringify(balBefore.map((b) => b.consumed)),
      "…and it consumed NO leave balance — the person is not quietly left short");
    const noReason = await threw(() => PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "fine", date: "2026-09-07", action: "waive" }, clean._id, SCOPE()));
    ok(noReason && noReason.status === 400, "a waiver without a reason is refused");
    eq(m2.netBeforeStatutory, 57500, "net = 60,000 − 2,000 LOP − 500 fine");

    // ── 6. FINES COME FROM THE SNAPSHOT ─────────────────────────────────────
    console.log("\n6. fines are read from each row's snapshot, never recomputed");
    const fineItem = m2.items.find((i) => i.kind === "fine" && i.date === "2026-09-07");
    eq(fineItem.amount, 500, "the fine is the stored amount");
    eq(fineItem.lateMinutes, 75, "…with the minutes that earned it");
    ok(fineItem.policy && fineItem.policy.graceMinutes === 20, "…and the policy it was judged against");
    const src = require("fs").readFileSync("services/PayrollService.js", "utf8");
    ok(!/judgeCheckIn|hr\.lateBands/.test(src), "PayrollService never re-derives a fine from current settings");

    // ── 7. PRO-RATION AND HONEST DEGRADATION ────────────────────────────────
    console.log("\n7. pro-ration only on known dates");
    const jLine = lineFor(s2, joiner._id);
    eq(jLine.prorated, true, "a mid-month joiner is pro-rated");
    eq(jLine.daysEmployed, 21, "…for the days actually employed (10th-30th)");
    eq(jLine.payableGross, 42000, "…21/30 of ₹60,000");
    const uLine = lineFor(s2, unknown._id);
    eq(uLine.prorated, false, "an unknown start date is NOT pro-rated off a guess");
    eq(uLine.payableGross, 60000, "…they are paid a full month");
    ok(uLine.flags.some((f) => /start date not recorded/.test(f)), "…and the row says why");

    // ── 8. BLOCKING ─────────────────────────────────────────────────────────
    console.log("\n8. missing salary blocks, and the person is still on the sheet");
    const nLine = lineFor(s2, noSal._id);
    ok(!!nLine, "someone with no salary record still APPEARS on the sheet");
    eq(nLine.payableGross, 0, "…at gross 0");
    ok(nLine.blocking.some((b) => /No salary record/.test(b)), "…with a blocking flag");
    ok(!lineFor(s2, svc._id), "a service account is excluded entirely");

    // ── 9. INCOMPLETE DAYS ──────────────────────────────────────────────────
    console.log("\n9. an unactioned incomplete day is PAID and surfaced");
    ok(m2.incompleteDays.includes("2026-09-03"), "the incomplete day is listed");
    ok(!m2.items.some((i) => i.date === "2026-09-03"), "…and is NOT proposed for deduction");
    ok(m2.flags.some((f) => /incomplete day/.test(f) && /paid unless converted/.test(f)), "…flagged as paid unless converted");
    await PayrollService.convertIncompleteToLop(MONTH, { adminId: messy._id, date: "2026-09-03" }, clean._id, SCOPE());
    let s3 = (await PayrollService.getSheet(MONTH, clean._id, SCOPE())).sheet;
    let m3 = lineFor(s3, messy._id);
    ok(m3.items.some((i) => i.date === "2026-09-03" && i.source === "marked_lop"), "converting it makes it a LOP proposal");
    eq(m3.items.find((i) => i.date === "2026-09-03").status, "pending", "…which still needs actioning");

    // ── 10. FINALISE ────────────────────────────────────────────────────────
    console.log("\n10. finalising recomputes, blocks, then freezes");
    const blockedPending = await threw(() => PayrollService.finalise(MONTH, clean._id, SCOPE()));
    ok(blockedPending && blockedPending.code === "UNACTIONED_ITEMS", `unactioned items block finalising (${blockedPending && blockedPending.message})`);
    await PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "lop", date: "2026-09-03", action: "waive", reason: "laptop died, work delivered" }, clean._id, SCOPE());
    const blockedSalary = await threw(() => PayrollService.finalise(MONTH, clean._id, SCOPE()));
    ok(blockedSalary && blockedSalary.code === "BLOCKING_FLAGS", `a missing salary still blocks (${blockedSalary && blockedSalary.message})`);
    await PayrollService.setSalary({ adminId: noSal._id, annualCtc: 360000, effectiveFrom: "2025-01-01" }, clean._id);

    const fin = await PayrollService.finalise(MONTH, clean._id, SCOPE());
    eq(fin.run.status, "finalised", "the run finalises");
    ok(!!fin.run.finalisedAt && !!fin.run.finalisedBy, "…recording who and when");
    ok(!!fin.run.snapshot, "…and freezing the sheet");
    eq(fin.run.dayDivisor, 30, "…with the divisor it used");

    // frozen and reproducible: change the source, the sheet must not move
    const frozenNet = lineFor(fin.run.snapshot, messy._id).netBeforeStatutory;
    await Attendance.create({ adminId: messy._id, date: "2026-09-15", checkInAt: new Date("2026-09-15T07:00:00Z"), dayStatus: "present", lateMinutes: 90, fineAmount: 500, policySnapshot: { workStartTime: "11:00", graceMinutes: 20, lateBands: [], source: "company" } });
    const after = await PayrollService.getSheet(MONTH, clean._id, SCOPE());
    eq(after.frozen, true, "a finalised run serves its FROZEN snapshot");
    eq(lineFor(after.sheet, messy._id).netBeforeStatutory, frozenNet, "…unchanged by later attendance edits");
    const reFinal = await threw(() => PayrollService.finalise(MONTH, clean._id, SCOPE()));
    ok(reFinal && reFinal.status === 409, "…and cannot be finalised twice");
    const reAct = await threw(() => PayrollService.actOnItem(MONTH, { adminId: messy._id, kind: "lop", date: "2026-09-02", action: "waive", reason: "x" }, clean._id, SCOPE()));
    ok(reAct && reAct.status === 409, "…nor re-opened by acting on an item");

    // ── 11. EXPORT ──────────────────────────────────────────────────────────
    console.log("\n11. the xlsx export");
    const wb = await PayrollExportService.buildWorkbook(fin.run.snapshot, { month: MONTH });
    const names = wb.worksheets.map((w) => w.name);
    eq(names.length, 3, `three sheets (${names.join(", ")})`);
    ok(names.includes("Deduction detail"), "…including the evidence behind every deduction");
    ok(names.includes("Basis"), "…and how the numbers were produced");
    const ws = wb.getWorksheet(`Payroll ${MONTH}`);
    const headers = ws.getRow(1).values.filter(Boolean).map(String);
    ok(headers.includes("Net (before statutory)"), "the net column says BEFORE STATUTORY");
    ok(headers.includes("Day Rate (gross/30)"), "…and the day rate states its basis");
    ok(headers.includes("LOP Days") && headers.includes("LOP Deduction"), "…exporting BOTH the day count and the rupee figure");
    const detail = wb.getWorksheet("Deduction detail");
    const rows = [];
    detail.eachRow((r, n) => { if (n > 1) rows.push(r.values.map(String)); });
    ok(rows.some((r) => r.join("|").includes("waived")), "waived items appear in the evidence sheet");
    ok(rows.some((r) => r.join("|").includes("incomplete")), "…as do incomplete days, marked paid");
    const buf = await PayrollExportService.toBuffer(fin.run.snapshot, { month: MONTH });
    ok(Buffer.isBuffer(Buffer.from(buf)) && buf.byteLength > 5000, `…and it writes a real workbook (${buf.byteLength} bytes)`);

    // ── 12. PERMISSIONS ─────────────────────────────────────────────────────
    console.log("\n12. permissions");
    ok(validatePermissions(["payroll:view:all", "payroll:approve:all", "payroll:export:all"]).valid, "the payroll vocabulary validates");
    const viewRole = await Role.create({ name: `${TAG}-v`, departmentId: dept._id, permissions: ["payroll:view:all"] });
    roles.push(viewRole._id);
    const viewer = await mk("Gviewer", { roleIds: [viewRole._id] });
    const okView = await runChain([requirePermission("payroll:view:all"), controller.Sheet], { auth: { user_id: viewer._id }, params: { month: MONTH }, body: {}, query: {} });
    eq(okView.status, 200, "a payroll:view holder can read the sheet");
    const noApprove = await runChain([requirePermission("payroll:approve:all"), controller.Finalise], { auth: { user_id: viewer._id }, params: { month: MONTH }, body: {}, query: {} });
    eq(noApprove.status, 403, "…but cannot finalise without payroll:approve");
    const stranger = await mk("Hstranger");
    const noView = await runChain([requirePermission("payroll:view:all"), controller.Sheet], { auth: { user_id: stranger._id }, params: { month: MONTH }, body: {}, query: {} });
    eq(noView.status, 403, "…and someone with no payroll grant sees nothing");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await PayrollRun.deleteOne({ month: MONTH });
    await EmployeeSalary.deleteMany({ adminId: { $in: admins } });
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await LeaveRequest.deleteMany({ adminId: { $in: admins } });
    await LeaveBalance.deleteMany({ adminId: { $in: admins } });
    await CompOff.deleteMany({ adminId: { $in: admins } });
    await CompanyHoliday.deleteMany({ name: { $regex: `^${TAG}` } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

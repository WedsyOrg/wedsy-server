/**
 * REIMBURSEMENTS - claims, receipts and the payroll addition (2026-08-25).
 *
 * The receipt path is deliberately NOT POST /file: that route admits customer
 * and vendor tokens, lets the caller name the S3 key so a second upload
 * overwrites the first, and re-encodes images to lossy JPEG. A receipt IS the
 * evidence, so it is stored byte-for-byte under a unique key.
 *
 * S3 is stubbed - this suite never uploads.
 *
 *   node tests/hr-reimbursement.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

// Stub the S3 writer BEFORE anything requires receiptStore, so no test ever
// puts an object in the real bucket.
const s3 = require("../utils/s3Upload");
const uploaded = [];
s3.uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  uploaded.push({ key, contentType, bytes: buffer.length });
  return `https://bucket.s3.region.amazonaws.com/${key}`;
};

const Reimbursement = require("../models/Reimbursement");
const PayrollRun = require("../models/PayrollRun");
const EmployeeSalary = require("../models/EmployeeSalary");
const Attendance = require("../models/Attendance");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const AdminNotification = require("../models/AdminNotification");
const RS = require("../services/ReimbursementService");
const PayrollService = require("../services/PayrollService");
const PayrollExportService = require("../services/PayrollExportService");
const receiptStore = require("../utils/receiptStore");

const TAG = `rmb-${Date.now()}`;
const MONTH = "2026-09";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  \u2713 ${label}`); } else { fail++; console.error(`  \u2717 ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const pad = (hex, n = 40) => Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(n)]);
const JPEG = () => pad("ffd8ffe000104a464946");
const PDF = () => pad("255044462d312e370a25");

const admins = [], roles = [], depts = [];
const lineFor = (sheet, id) => sheet.lines.find((l) => String(l.adminId) === String(id));

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    await PayrollRun.deleteOne({ month: MONTH });
    const dept = await Department.create({ name: `${TAG}-d` }); depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-f`, departmentId: dept._id, permissions: ["payroll:approve:all", "payroll:view:all"] });
    roles.push(founderRole._id);
    const mk = async (name, extra = {}) => {
      const a = await Admin.create({ name: `${TAG} ${name}`, email: `${TAG}${name}@x.com`, phone: `${TAG}${name}`, password: "x", status: "active", departmentId: dept._id, joinedAt: new Date("2025-01-01"), ...extra });
      admins.push(a._id); return a;
    };
    const founder = await mk("Founder", { roleIds: [founderRole._id] });
    const emp = await mk("Emp");
    await PayrollService.setSalary({ adminId: emp._id, annualCtc: 720000, effectiveFrom: "2025-01-01" }, founder._id);
    await PayrollService.setSalary({ adminId: founder._id, annualCtc: 1200000, effectiveFrom: "2025-01-01" }, founder._id);
    const SCOPE = () => ({ adminIds: admins });

    // -- 1. THE CLAIM ------------------------------------------------------
    console.log("1. filing a claim");
    const bad = await threw(() => RS.createClaim({ amountClaimed: 0, spentOn: "2026-09-02", category: "travel" }, emp._id));
    ok(bad && bad.status === 400, "a zero amount is refused");
    const badCat = await threw(() => RS.createClaim({ amountClaimed: 100, spentOn: "2026-09-02", category: "bribes" }, emp._id));
    ok(badCat && /category must be one of/.test(badCat.message), `an unknown category is refused (${badCat && badCat.message})`);
    const badDate = await threw(() => RS.createClaim({ amountClaimed: 100, spentOn: "02/09/2026", category: "travel" }, emp._id));
    ok(badDate && badDate.status === 400, "a non day-key date is refused");
    const svc = await mk("Svc", { meta: { isServiceAccount: true } });
    const svcTry = await threw(() => RS.createClaim({ amountClaimed: 100, spentOn: "2026-09-02", category: "travel" }, svc._id));
    eq(svcTry && svcTry.status, 403, "a service account cannot file a claim");

    const claim = await RS.createClaim({ amountClaimed: 2400, spentOn: "2026-09-02", category: "travel", note: "airport cab" }, emp._id);
    eq(claim.status, "pending", "a claim starts pending");
    eq(claim.amountClaimed, 2400, "…with the claimed amount");
    eq(claim.amountApproved, null, "…and nothing approved yet");
    eq(claim.attachments.length, 0, "…and no receipts");

    // -- 2. RECEIPTS -------------------------------------------------------
    console.log("\n2. receipts: original bytes, unique keys, server-side type");
    const noReceipts = await threw(() => RS.submit(claim._id, emp._id));
    ok(noReceipts && /at least one receipt/.test(noReceipts.message), "submitting with no receipt is refused");

    const jpg = JPEG();
    const withOne = await RS.addReceipt(claim._id, { buffer: jpg, filename: "IMG_4021.HEIC", declaredMime: "image/heic" }, emp._id);
    eq(withOne.attachments.length, 1, "a receipt attaches");
    const a0 = withOne.attachments[0];
    eq(a0.type, "image", "type recorded");
    eq(a0.contentType, "image/jpeg", "contentType is the SNIFFED type, not the browser's claim of image/heic");
    eq(a0.sizeBytes, jpg.length, "sizeBytes recorded");
    eq(a0.name, "IMG_4021.HEIC", "the claimant's original filename is kept");
    ok(!!a0.uploadedAt && String(a0.uploadedBy) === String(emp._id), "…with who uploaded it and when");

    eq(uploaded[uploaded.length - 1].bytes, jpg.length, "the ORIGINAL bytes went to S3 - not re-encoded");
    ok(uploaded[uploaded.length - 1].key.startsWith(`receipts/${claim._id}/`), `stored under the receipts-only prefix (${uploaded[uploaded.length - 1].key})`);

    const withTwo = await RS.addReceipt(claim._id, { buffer: PDF(), filename: "invoice.pdf", declaredMime: "application/pdf" }, emp._id);
    eq(withTwo.attachments.length, 2, "several receipts per claim");
    eq(withTwo.attachments[1].type, "pdf", "…a PDF is recognised");
    const keys = uploaded.slice(-2).map((u) => u.key);
    ok(keys[0] !== keys[1], "two uploads NEVER share a key - nothing can overwrite a receipt");

    const exe = await threw(() => RS.addReceipt(claim._id, { buffer: Buffer.from("MZ......executable......"), filename: "x.jpg", declaredMime: "image/jpeg" }, emp._id));
    ok(exe && exe.status === 400 && /not an image or a PDF/.test(exe.message), "an executable named .jpg is refused by MAGIC BYTES");
    const huge = await threw(() => RS.addReceipt(claim._id, { buffer: Buffer.alloc(receiptStore.MAX_BYTES + 1), filename: "big.jpg" }, emp._id));
    ok(huge && /limit is 15 MB/.test(huge.message), `over the cap is refused (${huge && huge.message})`);
    eq(receiptStore.MAX_BYTES, 15 * 1024 * 1024, "the cap is 15 MB");

    const other = await mk("Other");
    // Everyone on the sheet needs a salary or finalising is (correctly) blocked.
    await PayrollService.setSalary({ adminId: other._id, annualCtc: 480000, effectiveFrom: "2025-01-01" }, founder._id);
    const notMine = await threw(() => RS.addReceipt(claim._id, { buffer: JPEG(), filename: "a.jpg" }, other._id));
    eq(notMine && notMine.status, 403, "someone else cannot attach to my claim");

    // -- 3. DECISIONS ------------------------------------------------------
    console.log("\n3. three outcomes, founder-only, both figures kept");
    await RS.submit(claim._id, emp._id);
    const notified = await AdminNotification.countDocuments({ adminId: founder._id, type: "reimbursement_claim" });
    ok(notified >= 1, "submitting notifies a founder - every claim goes to one");

    const own = await threw(() => RS.decide(claim._id, { outcome: "approve" }, emp._id));
    eq(own && own.status, 403, "you cannot decide your own claim");
    const partialNoReason = await threw(() => RS.decide(claim._id, { outcome: "partial", amountApproved: 1500 }, founder._id));
    ok(partialNoReason && /reason is required/.test(partialNoReason.message), "a different amount REQUIRES a reason");
    const partialTooBig = await threw(() => RS.decide(claim._id, { outcome: "partial", amountApproved: 2400, reason: "x" }, founder._id));
    ok(partialTooBig && /LESS than the amount claimed/.test(partialTooBig.message), "a 'partial' equal to the claim is refused - that is an approval");

    const decided = await RS.decide(claim._id, { outcome: "partial", amountApproved: 1500, reason: "cab shared with two others" }, founder._id);
    eq(decided.status, "partial", "partial recorded");
    eq(decided.amountApproved, 1500, "…the approved figure");
    eq(decided.amountClaimed, 2400, "…and the CLAIMED figure is preserved, never overwritten");
    eq(decided.decisionReason, "cab shared with two others", "…with the reason");
    ok(String(decided.decidedBy) === String(founder._id) && !!decided.decidedAt, "…and who decided, when");
    const twice = await threw(() => RS.decide(claim._id, { outcome: "approve" }, founder._id));
    ok(twice && twice.status === 409, "a second decision is refused");

    const c2 = await RS.createClaim({ amountClaimed: 800, spentOn: "2026-09-05", category: "food" }, emp._id);
    await RS.addReceipt(c2._id, { buffer: JPEG(), filename: "b.jpg" }, emp._id);
    const rejNoReason = await threw(() => RS.decide(c2._id, { outcome: "reject" }, founder._id));
    ok(rejNoReason && /reason is required/.test(rejNoReason.message), "rejection requires a reason");
    const rejected = await RS.decide(c2._id, { outcome: "reject", reason: "personal meal" }, founder._id);
    eq(rejected.status, "rejected", "rejection recorded");
    eq(rejected.amountApproved, 0, "…approving nothing");

    const c3 = await RS.createClaim({ amountClaimed: 1200, spentOn: "2026-09-08", category: "materials" }, emp._id);
    await RS.addReceipt(c3._id, { buffer: PDF(), filename: "c.pdf" }, emp._id);
    const full = await RS.decide(c3._id, { outcome: "approve" }, founder._id);
    eq(full.amountApproved, 1200, "a full approval mirrors the claimed amount");

    // -- 4. EVIDENCE IS IMMUTABLE ONCE DECIDED -----------------------------
    console.log("\n4. a decided claim's evidence cannot change");
    const svcGuard = await threw(() => RS.addReceipt(claim._id, { buffer: JPEG(), filename: "late.jpg" }, emp._id));
    ok(svcGuard && svcGuard.status === 409, `the service refuses a late attachment (${svcGuard && svcGuard.message})`);
    const viaUpdate = await threw(() => Reimbursement.updateOne({ _id: claim._id }, { $push: { attachments: { type: "image", url: "https://x/y.jpg" } } }));
    ok(viaUpdate && /immutable/i.test(viaUpdate.message), "…and so does the MODEL, on a direct $push");
    const viaSet = await threw(() => Reimbursement.updateOne({ _id: claim._id }, { $set: { attachments: [] } }));
    ok(viaSet && /immutable/i.test(viaSet.message), "…on a $set of the whole array");
    const viaSave = await threw(async () => {
      const d = await Reimbursement.findById(claim._id);
      d.attachments = [];
      await d.save();
    });
    ok(viaSave && /immutable/i.test(viaSave.message), "…and on doc.save()");
    const still = await Reimbursement.findById(claim._id).lean();
    eq(still.attachments.length, 2, "…the two receipts are intact");
    // a PENDING claim stays editable
    const c4 = await RS.createClaim({ amountClaimed: 500, spentOn: "2026-09-09", category: "other" }, emp._id);
    const added = await RS.addReceipt(c4._id, { buffer: JPEG(), filename: "d.jpg" }, emp._id);
    const removed = await RS.removeReceipt(c4._id, added.attachments[0].url, emp._id);
    eq(removed.attachments.length, 0, "a PENDING claim's receipts can still be added and removed");

    // -- 5. PAYROLL: AN ADDITION, NEVER A NETTED DEDUCTION -----------------
    console.log("\n5. approved claims are an ADDITION on the sheet");
    await Attendance.create({ adminId: emp._id, date: "2026-09-02", checkInAt: new Date("2026-09-02T06:00:00Z"), dayStatus: "present", lateMinutes: 35, fineAmount: 300, policySnapshot: { workStartTime: "11:00", graceMinutes: 20, lateBands: [], source: "company" } });
    let { sheet } = await PayrollService.getSheet(MONTH, founder._id, SCOPE());
    let line = lineFor(sheet, emp._id);
    eq(line.reimbursements, 2700, "unpaid approved claims total 1500 + 1200");
    eq(line.reimbursementItems.length, 2, "…listed individually");
    const partialItem = line.reimbursementItems.find((r) => r.status === "partial");
    eq(partialItem.amountClaimed, 2400, "…each carrying what was claimed");
    eq(partialItem.amountApproved, 1500, "…and what was approved");
    ok(!line.reimbursementItems.some((r) => r.status === "rejected"), "a rejected claim is NOT on the sheet");

    // it must not net against the deduction
    eq(line.totalDeductions, 0, "the fine is still unactioned, so deductions are 0");
    eq(line.netBeforeStatutory, 60000 + 2700, "net = gross + reimbursements");
    await PayrollService.actOnItem(MONTH, { adminId: emp._id, kind: "fine", date: "2026-09-02", action: "approve", reason: "" }, founder._id, SCOPE());
    sheet = (await PayrollService.getSheet(MONTH, founder._id, SCOPE())).sheet;
    line = lineFor(sheet, emp._id);
    eq(line.totalDeductions, 300, "the approved fine deducts 300");
    eq(line.reimbursements, 2700, "…and reimbursements are UNCHANGED - never netted against it");
    eq(line.netBeforeStatutory, 60000 - 300 + 2700, "net = gross - deductions + additions");
    ok(sheet.totals.reimbursements >= 2700, `the run TOTAL picks them up (${sheet.totals.reimbursements})`);

    // -- 6. PAID ONCE ------------------------------------------------------
    console.log("\n6. finalising stamps them paid, exactly once");
    const fin = await PayrollService.finalise(MONTH, founder._id, SCOPE());
    eq(fin.run.status, "finalised", "the run finalises");
    const paid = await Reimbursement.find({ _id: { $in: [claim._id, c3._id] } }).lean();
    ok(paid.every((c) => c.paidWithRun === MONTH), "both approved claims are stamped with the run that paid them");
    const rejStill = await Reimbursement.findById(c2._id).lean();
    eq(rejStill.paidWithRun, null, "…and the rejected one is not");
    const unpaidNow = await RS.unpaidApprovedFor(emp._id);
    eq(unpaidNow.length, 0, "no unpaid approved claims remain - a later run cannot pay them again");

    // -- 7. EXPORT ---------------------------------------------------------
    console.log("\n7. the export keeps them separate");
    const wb = await PayrollExportService.buildWorkbook(fin.run.snapshot, { month: MONTH });
    const ws = wb.getWorksheet(`Payroll ${MONTH}`);
    const headers = ws.getRow(1).values.filter(Boolean).map(String);
    ok(headers.includes("Reimbursements"), "a Reimbursements column of its own");
    ok(headers.indexOf("Reimbursements") !== headers.indexOf("Total Deductions"), "…distinct from Total Deductions");
    const ev = wb.getWorksheet("Deduction detail");
    const rows = [];
    ev.eachRow((r, n) => { if (n > 1) rows.push(r.values.map(String).join("|")); });
    ok(rows.some((r) => r.includes("reimb")), "each claim appears in the evidence sheet");
    ok(rows.some((r) => r.includes("claimed 2400")), "…and a partial shows what was claimed against what was paid");
  } catch (e) {
    fail++; console.error("  \u2717 threw:", e);
  } finally {
    await Reimbursement.deleteMany({ claimant: { $in: admins } });
    await PayrollRun.deleteOne({ month: MONTH });
    await EmployeeSalary.deleteMany({ adminId: { $in: admins } });
    await Attendance.deleteMany({ adminId: { $in: admins } });
    await AdminNotification.deleteMany({ adminId: { $in: admins } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Role.deleteMany({ _id: { $in: roles } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

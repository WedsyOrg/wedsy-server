// L2+L3 — PAYMENT MILESTONES + MONEY FACE test. Run: node tests/payment-milestones.test.js
// Covers: milestone CRUD (whitelisted patch), the derived status ladder
// (pending → partial → paid, overdue), payment tagging, and the composed
// money-face read (dealValue, received/balance, schedule, ledger flags,
// documents from real generation traces, walletApplied/discounts honesty).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadPayment = require("../models/LeadPayment");
const PaymentMilestone = require("../models/PaymentMilestone");
const PaymentMilestoneService = require("../services/PaymentMilestoneService");
const LeadPaymentService = require("../services/LeadPaymentService");
const MoneyFaceService = require("../services/MoneyFaceService");
const LeadActivityEvent = require("../models/LeadActivityEvent");

const TAG = `moneyface-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: admin._id, dealTotal: 400000,
      dealValue: { amount: 400000, history: [{ amount: 400000, at: now, by: admin._id, phase: "quoted" }] },
      agreementSentAt: { at: now, by: admin._id },
    });
    created.leads.push(lead._id);

    // ── CRUD + status ladder ──
    const m1 = await PaymentMilestoneService.create(lead._id, { name: "Booking", amount: 100000, dueAt: new Date(+now + 7 * DAY) }, admin._id);
    const m2 = await PaymentMilestoneService.create(lead._id, { name: "Mid", amount: 200000, dueAt: new Date(+now - 2 * DAY) }, admin._id);
    const m3 = await PaymentMilestoneService.create(lead._id, { name: "Final", amount: 100000 }, admin._id);
    ok(m1.status === "pending" && m1.paidAmount === 0, "no payments → pending");
    ok(m2.status === "overdue", "past dueAt, unpaid → overdue");
    ok(m3.status === "pending" && m3.sortOrder > m2.sortOrder, "sortOrder auto-appends");

    let bad = null;
    try { await PaymentMilestoneService.create(lead._id, { name: "", amount: 100 }, admin._id); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "nameless milestone → 400");
    bad = null;
    try { await PaymentMilestoneService.patch(lead._id, m1._id, { leadId: created.leads[0] }); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "patch with no whitelisted field → 400");

    // partial then paid
    await LeadPaymentService.record(lead._id, { amount: 40000, mode: "bank", milestoneId: m1._id }, admin._id);
    let sched = await PaymentMilestoneService.listForLead(lead._id);
    ok(sched.find((m) => String(m._id) === String(m1._id)).status === "partial", "some money → partial");
    await LeadPaymentService.record(lead._id, { amount: 60000, mode: "upi", milestoneId: m1._id }, admin._id);
    sched = await PaymentMilestoneService.listForLead(lead._id);
    const m1now = sched.find((m) => String(m._id) === String(m1._id));
    ok(m1now.status === "paid" && m1now.paidAmount === 100000, "covered → paid with paidAmount");
    // overdue + partial stays overdue until covered
    await LeadPaymentService.record(lead._id, { amount: 50000, mode: "bank", milestoneId: m2._id }, admin._id);
    sched = await PaymentMilestoneService.listForLead(lead._id);
    ok(sched.find((m) => String(m._id) === String(m2._id)).status === "overdue", "past-due partial stays overdue");

    // patch whitelisted field + delete untags payments
    const patched = await PaymentMilestoneService.patch(lead._id, m3._id, { amount: 110000, name: "Final leg" });
    ok(patched.amount === 110000 && patched.name === "Final leg", "whitelisted patch lands");
    await PaymentMilestoneService.remove(lead._id, m2._id);
    const orphan = await LeadPayment.findOne({ leadId: lead._id, amount: 50000 }).lean();
    ok(orphan.milestoneId === null, "deleting a milestone untags its payments");

    // ── the money face ──
    // one gateway payment (couple app) + stamp an invoiceNumber on one payment
    await LeadPayment.create({ leadId: lead._id, amount: 25000, mode: "razorpay", recordedBy: null });
    await LeadPayment.updateOne({ leadId: lead._id, amount: 40000 }, { $set: { invoiceNumber: "WD-24-0042" } });

    const face = await MoneyFaceService.moneyFace(lead._id);
    ok(face.dealValue.amount === 400000 && face.dealValue.history.length === 1, "dealValue + history ride the face");
    ok(face.total === 400000, "total = dealTotal");
    ok(face.received === 40000 + 60000 + 50000 + 25000, `received sums the ledger (${face.received})`);
    ok(face.balance === 400000 - face.received, "balance = total − received");
    ok(face.schedule.length === 2 && face.schedule.every((m) => "status" in m && "paidAmount" in m), "schedule rides decorated");
    const gw = face.ledger.find((p) => p.mode === "razorpay");
    const bank = face.ledger.find((p) => p.amount === 40000);
    ok(gw.viaCoupleApp === true && bank.viaCoupleApp === false, "viaCoupleApp = no recording admin");
    ok(bank.recordedByName === `${TAG}-admin`, "recordedByName resolved");
    ok(bank.milestoneId === String(m1._id), "ledger rows carry their milestone tag");
    const agr = face.documents.find((d) => d.type === "agreement");
    const inv = face.documents.find((d) => d.type === "invoice");
    ok(!!agr && agr.url === `/enquiry/${lead._id}/agreement.pdf` && agr.auto === true, "agreement document entry points at the generator");
    ok(!!inv && inv.name === "WD-24-0042" && /invoice\.pdf$/.test(inv.url), "stamped invoiceNumber → invoice document entry");
    ok(face.walletApplied === null, "walletApplied is null (no wallet concept — honest)");
    ok(Array.isArray(face.discounts) && face.discounts.length === 0, "discounts [] (no records exist — honest)");

    // empty schedule is fine for old leads
    const bare = await Enquiry.create({
      name: `${TAG}-bare`, phone: `${TAG}-bare`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default", lostStatus: "none",
    });
    created.leads.push(bare._id);
    const bareFace = await MoneyFaceService.moneyFace(bare._id);
    ok(bareFace.schedule.length === 0 && bareFace.received === 0 && bareFace.total === null, "old lead with nothing → empty face, no migration needed");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPayment.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await PaymentMilestone.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

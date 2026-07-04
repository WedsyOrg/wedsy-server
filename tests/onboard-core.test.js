/**
 * Onboard core — Slice B5a.
 *
 *   node tests/onboard-core.test.js
 *
 * Covers: the removed meeting_scheduled gate (onboard straight from qualified),
 * atomic effects (stage won + Project + fee payment + broadcast + lane echo),
 * the winAudience setting, NO amount anywhere in the broadcast, dup → 409,
 * dealTotal audit, ledger math.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const Project = require("../models/Project");
const LeadPayment = require("../models/LeadPayment");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const SettingsService = require("../services/SettingsService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const LeadPaymentService = require("../services/LeadPaymentService");

const TAG = `onboard-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  const audienceSnapshot = await SettingsService.get("broadcast.winAudience");
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}o@x.com`, phone: `${TAG}o`, password: "x", status: "active", departmentId: dept._id });
    const teammate = await Admin.create({ name: `${TAG}-mate`, email: `${TAG}m@x.com`, phone: `${TAG}m`, password: "x", status: "active", departmentId: dept._id });
    const inactive = await Admin.create({ name: `${TAG}-gone`, email: `${TAG}g@x.com`, phone: `${TAG}g`, password: "x", status: "inactive", departmentId: dept._id });
    adminIds.push(owner._id, teammate._id, inactive._id);

    // Qualified lead sitting at stage "contacted" — NO meeting ever booked.
    const lead = await Enquiry.create({
      name: "Onboard Lead", phone: `${TAG}`, verified: false, isInterested: false, isLost: false,
      stage: "contacted", source: "Default", assignedTo: owner._id,
      qualified: true, qualifiedAt: new Date(),
      qualificationData: { groomName: "Karthik", brideName: "Ananya" },
    });
    leadIds.push(lead._id);
    await LeadLane.create({ leadId: lead._id, key: "lead_comms", name: "Lead communication", ownerId: owner._id, state: "active", lastUpdateAt: new Date() });

    // ── 1. dealTotal audit.
    console.log("1. deal total");
    await LeadLifecycleService.setDealTotal(lead._id, 1225000, owner._id);
    const dtEv = await LeadInternalEvent.find({ leadId: lead._id, type: "deal_total_changed" }).lean();
    ok(dtEv.length === 1 && dtEv[0].payload.from === null && dtEv[0].payload.to === 1225000, "deal_total_changed audited {from,to}");

    // ── 2. Onboard from qualified/contacted (gate removed) — full effects.
    console.log("2. onboard hinge");
    await SettingsService.set("broadcast.winAudience", "all");
    const r = await LeadLifecycleService.onboardClient(lead._id, { feeAmount: 25000, mode: "razorpay" }, owner._id);
    ok(r.lead.stage === "won", "stage → won without ever being meeting_scheduled (gate removed)");
    const project = await Project.findOne({ leadId: lead._id }).lean();
    ok(!!project && project.value === 1225000, "Project created through the SHARED convertLead path, value = dealTotal");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "converted_to_project" })) === 1, "converted_to_project event (shared path ran)");
    const payments = await LeadPayment.find({ leadId: lead._id }).lean();
    ok(payments.length === 1 && payments[0].amount === 25000 && payments[0].mode === "razorpay" && String(payments[0].projectId) === String(project._id),
      "fee payment #1 recorded and linked to the project");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "client_onboarded" })) === 1, "client_onboarded journey event");
    ok((await LaneEntry.countDocuments({ leadId: lead._id, autoType: "agreement" })) === 1, "lead_comms lane echo");

    // ── 3. Win broadcast — audience + NO amount.
    console.log("3. win broadcast");
    const wins = await AdminNotification.find({ leadId: lead._id, type: "client_won" }).lean();
    const winIds = new Set(wins.map((w) => String(w.adminId)));
    ok(winIds.has(String(owner._id)), "actor/owner INCLUDED in the bell");
    ok(winIds.has(String(teammate._id)), "audience 'all' reaches every active admin");
    ok(!winIds.has(String(inactive._id)), "inactive admins excluded");
    ok(wins[0].title === `🏆 Client won by ${TAG}-owner`, "title names the owner");
    ok(wins[0].message === "Karthik & Ananya is now a Wedsy client", "message names the couple");
    const serialized = JSON.stringify(wins);
    ok(!/25000|1225000|amount/i.test(serialized), "NO amount anywhere in any broadcast document");

    // ── 4. Dup onboard → 409.
    let dup = null;
    try { await LeadLifecycleService.onboardClient(lead._id, { feeAmount: 1 }, owner._id); } catch (e) { dup = e.status; }
    ok(dup === 409, `second onboard → 409 (got ${dup})`);

    // ── 5. Ledger math.
    console.log("4. ledger");
    await LeadPaymentService.record(lead._id, { amount: 480000, mode: "upi" }, owner._id);
    const ledger = await LeadPaymentService.listForLead(lead._id);
    ok(ledger.total === 1225000 && ledger.received === 505000 && ledger.balance === 720000,
      `total/received/balance = ${ledger.total}/${ledger.received}/${ledger.balance}`);

    // ── 6. Audience setting: leadership-only.
    console.log("5. winAudience = sales_cs_leadership");
    await SettingsService.set("broadcast.winAudience", "sales_cs_leadership");
    const lead2 = await Enquiry.create({
      name: "Lead Two", phone: `${TAG}-2`, verified: false, isInterested: false, isLost: false,
      stage: "contacted", source: "Default", assignedTo: owner._id, qualified: true, qualifiedAt: new Date(),
    });
    leadIds.push(lead2._id);
    await LeadLifecycleService.onboardClient(lead2._id, { feeAmount: 10000 }, owner._id);
    const wins2 = await AdminNotification.find({ leadId: lead2._id, type: "client_won" }).lean();
    const win2Ids = new Set(wins2.map((w) => String(w.adminId)));
    ok(win2Ids.has(String(owner._id)), "lead owner still rings");
    ok(!win2Ids.has(String(teammate._id)), "plain teammate NOT in the leadership audience");
    const pay2 = await LeadPayment.findOne({ leadId: lead2._id }).lean();
    ok(pay2.mode === "bank", 'mode defaults to "bank"');
  } finally {
    if (leadIds.length) {
      await LeadPayment.deleteMany({ leadId: { $in: leadIds } });
      await Project.deleteMany({ leadId: { $in: leadIds } });
      await LaneEntry.deleteMany({ leadId: { $in: leadIds } });
      await LeadLane.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await SettingsService.set("broadcast.winAudience", audienceSnapshot);
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });

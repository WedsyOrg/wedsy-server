// BUG 80 + BUG 79 MONEY test. Run: node tests/discount-set-clear.test.js
// Covers: the SET discount semantic (exact amount, reduce, remove-to-zero,
// old→new plan_change audit, guards: negative/over-gross/locked), coexistence
// with the legacy grant path, and the Bug 79 audit — a TS mandatory item
// counted ONCE (event level, not day), a "No" answer priced nowhere, and
// grand = Σ days + TS lines − discount to the rupee.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const DealDiscount = require("../models/DealDiscount");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const PlanSnapshotService = require("../services/PlanSnapshotService");
const { eventTotals } = require("../utils/eventDecorPricing");

const TAG = `disc80-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }],
    });
    created.decors.push(decor._id);
    const draft = await DraftEventService.createDraft(lead._id, { name: "Disc" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);

    // ── Bug 79 money fixture ──
    await DraftEventService.addItem(lead._id, draft._id, day._id, { decorId: decor._id, quantity: 2 }, admin._id); // 2000
    await DraftEventService.addCustomItem(lead._id, draft._id, day._id, { name: "ES custom", price: 300 });                       // day
    await DraftEventService.addCustomItem(lead._id, draft._id, day._id, { name: "TS custom", price: 700, includeInTotalSummary: true }); // event level
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: "TS mandatory", price: 500, itemRequired: true, includeInTotalSummary: true });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: "ES mandatory", price: 400, itemRequired: true });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: "Answered No", price: 900, itemRequired: false });

    const evDoc = await Event.findById(draft._id).lean();
    const t = eventTotals(evDoc);
    const dayRow = t.days.find((d) => d.name === "Sangeet");
    ok(dayRow.total === 2000 + 300 + 400, `ES rows only in the day total (₹${dayRow.total})`);
    ok(dayRow.mandatoryItems === 400, "TS mandatory NOT in its day's mandatory sum (counted once)");
    const tsNames = t.eventLevelItems.map((i) => i.name);
    ok(tsNames.includes("TS custom") && tsNames.includes("TS mandatory") && t.eventLevelTotal === 1200,
      "TS rows lifted to eventLevelItems exactly once (₹1200)");
    ok(!tsNames.includes("Answered No") && !JSON.stringify(t).includes("Answered No"),
      "a No answer (itemRequired:false) appears in NO summary");
    ok(t.grandTotal === dayRow.total + t.eventLevelTotal, "grand = Σ days + TS lines");
    const GROSS = t.grandTotal; // 3900

    // ── Bug 80: legacy grant path still works ──
    const grant = await PlanSnapshotService.grantDiscount(lead._id, draft._id, { amount: 1000 }, admin._id);
    ok(grant.status === "approved" && grant.amount === 1000, "legacy POST/grant path unchanged (still used by PlannerDecor + tests)");
    let totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.discount === 1000, "grant summed as before");

    // ── SET: exact amount replaces, not adds ──
    const s1 = await PlanSnapshotService.setDiscount(lead._id, draft._id, { amount: 3000 }, admin._id);
    ok(s1.discount === 3000 && s1.net === GROSS - 3000, "SET makes the discount EXACTLY ₹3000 (not 1000+3000)");
    totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.discount === 3000 && totals.net === GROSS - 3000, "totals agree after SET");
    ok((await DealDiscount.countDocuments({ eventId: draft._id, status: "approved" })) === 1,
      "exactly ONE live discount row after SET (older rows superseded, kept as history)");

    // reduce
    const s2 = await PlanSnapshotService.setDiscount(lead._id, draft._id, { amount: 1500 }, admin._id);
    ok(s2.discount === 1500 && s2.net === GROSS - 1500, "SET can REDUCE (3000 → 1500)");
    ok(Math.abs(s2.equivalentPct - (1500 / GROSS) * 100) < 0.06, `equivalentPct still computed (${s2.equivalentPct}%)`);

    // grand = Σ days + TS − discount, to the rupee
    ok(s2.net === dayRow.total + t.eventLevelTotal - 1500, "grand = Σ days + TS lines − discount, to the rupee");

    // remove entirely
    const s3 = await PlanSnapshotService.setDiscount(lead._id, draft._id, {}, admin._id);
    ok(s3.discount === 0 && s3.discountId === null, "amount omitted → discount removed");
    totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.discount === 0 && totals.net === totals.gross, "removal leaves net === gross");
    ok((await DealDiscount.countDocuments({ eventId: draft._id, status: { $in: ["approved", "pending"] } })) === 0,
      "…and NO live discount row anywhere");

    // audit trail: old → new
    const log = await LeadInternalEvent.find({ leadId: lead._id, type: "plan_change", "payload.op": "set_discount" }).sort({ createdAt: 1 }).lean();
    ok(log.length === 3 && log[0].payload.from === 1000 && log[0].payload.to === 3000
      && log[1].payload.from === 3000 && log[1].payload.to === 1500
      && log[2].payload.from === 1500 && log[2].payload.to === 0,
      "plan_change records every old → new transition");
    ok(log.every((l) => String(l.actorId) === String(admin._id)), "…with the actor");

    // guards
    let neg = null;
    try { await PlanSnapshotService.setDiscount(lead._id, draft._id, { amount: -50 }, admin._id); } catch (e) { neg = e; }
    ok(neg && neg.status === 400, "negative amount → 400");
    let over = null;
    try { await PlanSnapshotService.setDiscount(lead._id, draft._id, { amount: GROSS + 1 }, admin._id); } catch (e) { over = e; }
    ok(over && over.status === 422, "amount > gross → 422");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: true } });
    let locked = null;
    try { await PlanSnapshotService.setDiscount(lead._id, draft._id, { amount: 100 }, admin._id); } catch (e) { locked = e; }
    ok(locked && locked.status === 409, "locked draft → 409");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: false } });
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await DealDiscount.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

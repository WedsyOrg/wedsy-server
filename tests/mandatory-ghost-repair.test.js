// MANDATORY GHOST REPAIR test (T1). Run: node tests/mandatory-ghost-repair.test.js
// Covers the detection logic (classifyDayConcept: repairable ghost, single-row
// left alone, keeper-only left alone, legacy-only ambiguous) and the actual
// $pull repair on a seeded OS draft — keeper survives, legacy sibling dropped,
// the answer unchanged, totals shed exactly the ghost's rupees, and a second
// pass is a no-op (idempotent).
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Event = require("../models/Event");
const EventMandatoryQuestion = require("../models/EventMandatoryQuestion");
const DraftEventService = require("../services/DraftEventService");
const { classifyDayConcept, billImpact, CONCEPTS } = require("../scripts/repair-mandatory-ghosts");

const TAG = `mghost-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], events: [], questions: [] };
const GEN = CONCEPTS.find((c) => c.key === "generator");

// mimic the script's in-scope $pull repair for one day
const dropLegacy = async (eventId, dayIdx, dropIds) =>
  Event.updateOne(
    { _id: eventId },
    { $pull: { [`eventDays.${dayIdx}.mandatoryItems`]: { _id: { $in: dropIds.map((id) => new mongoose.Types.ObjectId(id)) } } } }
  );

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── pure detection ──
    const keeperId = new mongoose.Types.ObjectId();
    const keeperIds = new Set([String(keeperId)]);
    const keeper = { _id: new mongoose.Types.ObjectId(), title: "Generator", questionId: keeperId, itemRequired: true, includeInTotalSummary: true, price: 8000 };
    const legacy = { _id: new mongoose.Types.ObjectId(), title: "Generator (6Hrs) - Format", questionId: null, itemRequired: true, includeInTotalSummary: true, price: 14000 };
    const single = { _id: new mongoose.Types.ObjectId(), title: "Generator (6Hrs)", questionId: null, itemRequired: true, price: 14000 };
    const transport = { _id: new mongoose.Types.ObjectId(), title: "Transportation", questionId: null, itemRequired: true, price: 1000 };

    const v1 = classifyDayConcept([keeper, legacy, transport], GEN, keeperIds);
    ok(v1 && v1.keepers && v1.keepers.length === 1 && v1.legacy.length === 1
      && String(v1.keepers[0]._id) === String(keeper._id) && String(v1.legacy[0]._id) === String(legacy._id),
      "keeper+legacy on one day → repairable ghost (keep the questionId row, drop the legacy)");
    ok(classifyDayConcept([single, transport], GEN, keeperIds) === null,
      "a day's ONLY generator row is left alone (single-row group, not a ghost)");
    ok(classifyDayConcept([keeper, transport], GEN, keeperIds) === null,
      "keeper-only group is left alone");
    const amb = classifyDayConcept([legacy, single], GEN, keeperIds);
    ok(amb && amb.ambiguous && amb.ambiguous.length === 2,
      "two legacy rows, no keeper → ambiguous (reported, never auto-repaired)");
    ok(billImpact({ itemRequired: true, price: 14000 }) === 14000
      && billImpact({ itemRequired: false, price: 9000 }) === 0,
      "billImpact: required row counts, a No answer prices nowhere");

    // ── real repair on a seeded OS draft ──
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const q = await EventMandatoryQuestion.create({
      title: `${TAG}-Generator`, itemRequired: true,
      config: { type: "options", noteMaxLen: 0, axes: [{ name: "Size", options: ["64Kw", "128Kw"] }, { name: "Duration", options: ["6hrs", "12hrs"] }], priceMatrix: { "64Kw": { "6hrs": 8000, "12hrs": 15000 }, "128Kw": { "6hrs": 15000, "12hrs": 28000 } } },
    });
    created.questions.push(q._id);
    const lead = await Enquiry.create({ name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false, stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id });
    created.leads.push(lead._id);
    const draft = await DraftEventService.createDraft(lead._id, { name: "Ghost" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);
    // configured keeper (the re-answer) — resolves the matrix to 15000
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: `${TAG}-Generator`, questionId: String(q._id), itemRequired: true, includeInTotalSummary: true, selection: { Size: "64Kw", Duration: "12hrs" } });
    // the legacy ghost sibling baked on the same day (no questionId), still billing
    await Event.updateOne(
      { _id: draft._id, "eventDays._id": day._id },
      { $push: { "eventDays.$.mandatoryItems": { title: `${TAG}-Generator (6Hrs) - Format`, questionId: null, itemRequired: true, includeInTotalSummary: true, price: 14000 } } }
    );

    const before = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const grossBefore = before.totals.grandTotal;
    const conc = { key: "generator", label: "Generator", match: new RegExp(`${TAG}-Generator`, "i") };
    const evDoc = await Event.findById(draft._id).lean();
    const dayIdx = evDoc.eventDays.findIndex((d) => String(d._id) === String(day._id));
    const verdict = classifyDayConcept(evDoc.eventDays[dayIdx].mandatoryItems, conc, new Set([String(q._id)]));
    ok(verdict && verdict.legacy.length === 1 && verdict.legacy[0].price === 14000, "seeded ghost detected on the real draft (legacy sibling, ₹14000)");

    await dropLegacy(draft._id, dayIdx, verdict.legacy.map((mi) => String(mi._id)));
    const after = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const genRows = after.days[0].mandatoryItems.filter((mi) => /Generator/i.test(mi.title));
    ok(genRows.length === 1 && String(genRows[0].questionId) === String(q._id) && genRows[0].price === 15000,
      "after repair: ONLY the configured keeper survives, answer intact (₹15000 matrix price)");
    ok(after.totals.grandTotal === grossBefore - 14000, `totals shed exactly the ghost's ₹14000 (${grossBefore} → ${after.totals.grandTotal})`);

    // idempotent — a second pass finds nothing
    const evDoc2 = await Event.findById(draft._id).lean();
    const verdict2 = classifyDayConcept(evDoc2.eventDays[dayIdx].mandatoryItems, conc, new Set([String(q._id)]));
    ok(verdict2 === null, "second pass: no ghost remains (idempotent no-op)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await EventMandatoryQuestion.deleteMany({ _id: { $in: created.questions } }).catch(() => {});
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      const LeadPlan = require("../models/LeadPlan");
      const LeadInternalEvent = require("../models/LeadInternalEvent");
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

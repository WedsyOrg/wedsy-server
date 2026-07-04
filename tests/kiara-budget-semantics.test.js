/**
 * KIARA BUDGET SEMANTICS — overall-vs-per-service routing (internal layers).
 *
 * syncQualifiedToCrm must route the two budget facts to DIFFERENT homes:
 *   data.budget (OVERALL)        → qualificationData.budgetAmount (+budgetNote),
 *                                  via normalizeBudget.
 *   data.budgetPerService (LABEL)→ qualificationData.budgetPerService, stored RAW
 *                                  (never normalized, never touching budgetAmount).
 * A per-service figure like "catering ~3L" must never inflate the headline budget.
 *
 *   node tests/kiara-budget-semantics.test.js
 *
 * Seeds isolated leads; passes conversation.enquiryId so no phone lookup is needed;
 * stubs the (Anthropic) Kiara summary so the test is offline. Cleans up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const KiaraSummaryService = require("../services/KiaraSummaryService");
const KiaraCrmSyncService = require("../services/KiaraCrmSyncService");

const TAG = `budsem-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

let seq = 0;
const makeLead = async () => {
  seq += 1;
  const lead = await Enquiry.create({
    name: `Test Couple ${seq}`, phone: `${TAG}-${seq}`, verified: false,
    isInterested: false, isLost: false, stage: "new", source: "whatsapp",
  });
  return lead;
};
// Sync against a seeded lead via conversation.enquiryId (no phone normalization).
// eventDate omitted on purpose → ensureEventDays no-ops (no User/Event/network).
const sync = (lead, data) =>
  KiaraCrmSyncService.syncQualifiedToCrm(lead.phone, data, { enquiryId: lead._id });
const reload = (id) => Enquiry.findById(id).lean();

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  // Offline: the qualified-sync tail fires the Haiku summary — stub to a no-op.
  const origSummary = KiaraSummaryService.generateForQualified;
  KiaraSummaryService.generateForQualified = async () => {};

  const leadIds = [];
  try {
    // ── Case A: OVERALL only → fills budgetAmount/budgetNote; per-service empty.
    console.log("Case A: overall budget → budgetAmount, budgetPerService stays empty");
    const lA = await makeLead(); leadIds.push(lA._id);
    await sync(lA, { budget: "10-15k" });
    const a = await reload(lA._id);
    ok(a.qualificationData.budgetAmount === 10000, "budgetAmount = 10000 (lower bound of 10-15k)");
    ok(a.qualificationData.budgetNote === "10-15k", "budgetNote = raw overall phrasing");
    ok(a.qualificationData.budgetPerService === "", "budgetPerService untouched (empty)");

    // ── Case B: PER-SERVICE only → fills budgetPerService RAW; budgetAmount NOT set.
    console.log("Case B: per-service budget → budgetPerService raw, budgetAmount untouched");
    const lB = await makeLead(); leadIds.push(lB._id);
    await sync(lB, { budgetPerService: "catering ~3L" });
    const b = await reload(lB._id);
    ok(b.qualificationData.budgetPerService === "catering ~3L", "budgetPerService = raw labeled string (verbatim)");
    ok(b.qualificationData.budgetAmount === null, "budgetAmount NOT populated (per-service never inflates headline)");
    ok(b.qualificationData.budgetNote === "", "budgetNote NOT populated by a per-service figure");
    // Prove it was NOT normalized: "~3L" through normalizeBudget would be 300000.
    ok(b.qualificationData.budgetAmount !== 300000, "per-service '~3L' did NOT become budgetAmount 300000");

    // ── Case C: BOTH present → each routed to its own field independently.
    console.log("Case C: both present → routed independently");
    const lC = await makeLead(); leadIds.push(lC._id);
    await sync(lC, { budget: "20 lakh", budgetPerService: "decor 50k" });
    const c = await reload(lC._id);
    ok(c.qualificationData.budgetAmount === 2000000, "overall '20 lakh' → budgetAmount 2000000");
    ok(c.qualificationData.budgetNote === "20 lakh", "budgetNote = overall raw");
    ok(c.qualificationData.budgetPerService === "decor 50k", "budgetPerService = 'decor 50k' raw");

    // ── Case D: fill-only-empty — an existing per-service value is not clobbered.
    console.log("Case D: fill-only-empty guard on budgetPerService");
    const lD = await makeLead(); leadIds.push(lD._id);
    await Enquiry.findByIdAndUpdate(lD._id, { $set: { "qualificationData.budgetPerService": "photography 80k" } });
    await sync(lD, { budgetPerService: "catering 2L" });
    const d = await reload(lD._id);
    ok(d.qualificationData.budgetPerService === "photography 80k", "pre-existing budgetPerService preserved (not clobbered)");
  } finally {
    KiaraSummaryService.generateForQualified = origSummary;
    if (leadIds.length) await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });

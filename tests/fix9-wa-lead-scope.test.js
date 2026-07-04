/**
 * FIX #9 — WhatsApp lead-chat bleed.
 *
 * Proves WAConversationService.listInbox() intersects (does not bypass) the
 * requested enquiryId with the caller's scope. Run against the local CRM DB:
 *
 *   node tests/fix9-wa-lead-scope.test.js
 *
 * Seeds isolated, uniquely-tagged fixtures and removes them in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const WAConversation = require("../models/WAConversation");
const WAConversationService = require("../services/WAConversationService");

const TAG = `fix9-${Date.now()}`;
let pass = 0;
let fail = 0;

const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
};

const ids = (res) => res.list.map((c) => String(c._id)).sort();

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const ownerId = new mongoose.Types.ObjectId();
  const otherOwnerId = new mongoose.Types.ObjectId();
  const scopeFilter = { assignedTo: ownerId }; // mirrors buildScopeFilter("own")

  const baseLead = { verified: false, isInterested: false, isLost: false, stage: "new", source: "Default" };
  let createdLeadIds = [];
  let createdConvIds = [];

  try {
    // Two in-scope leads (A, B), one out-of-scope lead (C).
    const leadA = await Enquiry.create({ ...baseLead, name: `${TAG}-A`, phone: `${TAG}-A`, assignedTo: ownerId });
    const leadB = await Enquiry.create({ ...baseLead, name: `${TAG}-B`, phone: `${TAG}-B`, assignedTo: ownerId });
    const leadC = await Enquiry.create({ ...baseLead, name: `${TAG}-C`, phone: `${TAG}-C`, assignedTo: otherOwnerId });
    createdLeadIds = [leadA._id, leadB._id, leadC._id];

    // One WhatsApp conversation per lead (unique phones).
    const convA = await WAConversation.create({ phone: `${TAG}-wa-A`, enquiryId: leadA._id });
    const convB = await WAConversation.create({ phone: `${TAG}-wa-B`, enquiryId: leadB._id });
    const convC = await WAConversation.create({ phone: `${TAG}-wa-C`, enquiryId: leadC._id });
    createdConvIds = [convA._id, convB._id, convC._id];

    const A = String(convA._id);
    const B = String(convB._id);
    const C = String(convC._id);

    // Case 1: scoped admin + in-scope enquiryId → ONLY that lead's conversation.
    console.log("Case 1: scoped + in-scope enquiryId");
    const r1 = await WAConversationService.listInbox({ enquiryId: String(leadA._id) }, scopeFilter);
    ok(ids(r1).length === 1 && ids(r1)[0] === A, "returns exactly conv A (not list[0] of everything)");

    // Case 2: scoped admin + OUT-OF-SCOPE enquiryId → empty (no leak).
    console.log("Case 2: scoped + out-of-scope enquiryId");
    const r2 = await WAConversationService.listInbox({ enquiryId: String(leadC._id) }, scopeFilter);
    ok(r2.list.length === 0 && r2.total === 0, "returns empty — out-of-scope conversation NOT leaked");

    // Case 3: scoped admin + NO enquiryId → all in-scope conversations (inbox unchanged).
    console.log("Case 3: scoped + no enquiryId (inbox)");
    const r3 = await WAConversationService.listInbox({ limit: "100" }, scopeFilter);
    const r3ids = ids(r3);
    ok(r3ids.includes(A) && r3ids.includes(B), "includes both in-scope convs A and B");
    ok(!r3ids.includes(C), "excludes out-of-scope conv C");

    // Case 4: unscoped super-admin + enquiryId → resolves that lead.
    console.log("Case 4: unscoped + enquiryId");
    const r4 = await WAConversationService.listInbox({ enquiryId: String(leadC._id) }, {});
    ok(ids(r4).length === 1 && ids(r4)[0] === C, "super-admin resolves conv C by enquiryId");

    // Case 5: regression — two different in-scope leads → two DIFFERENT conversations.
    console.log("Case 5: regression — distinct leads → distinct conversations");
    const ra = await WAConversationService.listInbox({ enquiryId: String(leadA._id) }, scopeFilter);
    const rb = await WAConversationService.listInbox({ enquiryId: String(leadB._id) }, scopeFilter);
    ok(
      ids(ra).length === 1 && ids(rb).length === 1 && ids(ra)[0] === A && ids(rb)[0] === B && A !== B,
      "lead A → conv A, lead B → conv B (no bleed)"
    );
  } finally {
    if (createdConvIds.length) await WAConversation.deleteMany({ _id: { $in: createdConvIds } });
    if (createdLeadIds.length) await Enquiry.deleteMany({ _id: { $in: createdLeadIds } });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

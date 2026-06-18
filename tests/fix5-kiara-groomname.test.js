/**
 * FIX #5 — Kiara must not copy the WhatsApp contact name into groomName.
 *
 * KiaraCrmSyncService.syncQualifiedToCrm() used to set
 * qualificationData.groomName = data.name when both couple names were empty,
 * which made the lead's display name (groom & bride) show the contact name
 * instead of the captured FB-form name. This proves groomName/brideName stay
 * empty while the contact name remains on top-level `name`, and that the other
 * fill-if-empty mappings still work.
 *
 *   node tests/fix5-kiara-groomname.test.js
 *
 * Seeds an isolated, uniquely-tagged Enquiry against the local CRM DB and
 * removes it in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
// Stub the post-sync Haiku summary call (network) so the test is deterministic.
const KiaraSummaryService = require("../services/KiaraSummaryService");
KiaraSummaryService.generateForQualified = async () => {};

const KiaraCrmSyncService = require("../services/KiaraCrmSyncService");

const TAG = `fix5-${Date.now()}`;
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const phone = `9${String(Date.now()).slice(-9)}`; // 10-digit, unique per run
  let leadId = null;
  try {
    const lead = await Enquiry.create({
      name: "FB Contact Name",
      phone,
      verified: false,
      isInterested: false,
      isLost: false,
      stage: "new",
      source: "Default",
    });
    leadId = lead._id;

    // Kiara qualifies the conversation yielding only a contact name (plus a
    // couple of other facts to confirm unrelated mappings still fill).
    await KiaraCrmSyncService.syncQualifiedToCrm(
      phone,
      { name: "Chat Person", venueName: "Taj West End", weddingStyle: "South Indian" },
      null
    );

    const after = await Enquiry.findById(leadId).lean();
    const qd = after.qualificationData || {};

    console.log("FIX #5 — Kiara groom-name default removed");
    ok(qd.groomName === "", "qualificationData.groomName stays empty (contact name NOT copied)");
    ok(qd.brideName === "", "qualificationData.brideName stays empty");
    ok(after.name === "FB Contact Name", "top-level name preserved (FB contact name, not overwritten)");
    ok(after.qualified === true, "lead is marked qualified");
    // Regression: the other fill-if-empty mappings must be untouched by the fix.
    ok(qd.venueName === "Taj West End", "venueName still filled (mapping intact)");
    ok(qd.weddingStyle === "South Indian", "weddingStyle still filled (mapping intact)");
  } finally {
    if (leadId) await Enquiry.deleteMany({ _id: leadId });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

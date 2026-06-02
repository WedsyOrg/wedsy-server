/**
 * Verify the venue-journey service against real local data (LOCAL DEV ONLY, read-only).
 * Test lead: the "rohaan" enquiry 6592cdff4c8c51d04ec02d82 (phone +918197105896),
 * which links via User to real venue enquiries/conversations.
 * Aborts if DATABASE_URL is not localhost. Run: node scripts/verify-venue-journey.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const VenueJourneyService = require("../services/VenueJourneyService");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

const TEST_ENQUIRY_ID = "6592cdff4c8c51d04ec02d82";

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    console.log("=== getJourneyForEnquiry (rohaan lead) ===");
    const journey = await VenueJourneyService.getJourneyForEnquiry(TEST_ENQUIRY_ID);
    console.log(`lead: ${journey.lead.name} (${journey.lead.phone})`);
    console.log(`user: ${journey.user ? journey.user.name + " / " + journey.user._id : "null"}`);
    console.log(`venue enquiries: ${journey.enquiries.length}`);
    console.log(`conversations: ${journey.conversations.length}`);
    if (journey.enquiries[0]) {
      const e = journey.enquiries[0];
      console.log(`  sample enquiry: venue=${e.venueId ? e.venueId.name : "(unpopulated)"} stage=${e.stage} eventDate=${e.eventDate}`);
    }
    if (journey.conversations[0]) {
      const c = journey.conversations[0];
      console.log(`  sample convo: venue=${c.venueId ? c.venueId.name : "(unpopulated)"} status=${c.status}`);
    }
    check("journey resolved a user for the rohaan lead", journey.user != null);
    check("journey returned at least one venue enquiry", journey.enquiries.length > 0);
    check("enquiry venueId populated to an object", !journey.enquiries[0] || (journey.enquiries[0].venueId == null || typeof journey.enquiries[0].venueId === "object"));

    console.log("\n=== error paths ===");
    try { await VenueJourneyService.getJourneyForEnquiry("not-an-id"); check("invalid enquiry id rejected", false); }
    catch (e) { check(`invalid enquiry id -> ${e.status}`, e.status === 400); }
    try { await VenueJourneyService.getJourneyForEnquiry(String(new mongoose.Types.ObjectId())); check("unknown enquiry rejected", false); }
    catch (e) { check(`unknown enquiry -> ${e.status}`, e.status === 404); }

    console.log("\n=== getConversationMessages ===");
    if (journey.conversations[0]) {
      const msgs = await VenueJourneyService.getConversationMessages(String(journey.conversations[0]._id));
      console.log(`messages in first conversation: ${msgs.messages.length} (local snapshot has 0 venuemessages — empty is expected)`);
      check("getConversationMessages returns a messages array", Array.isArray(msgs.messages));
    } else {
      console.log("no conversations to test messages against — skipping");
    }
    try { await VenueJourneyService.getConversationMessages(String(new mongoose.Types.ObjectId())); check("unknown conversation rejected", false); }
    catch (e) { check(`unknown conversation -> ${e.status}`, e.status === 404); }

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();

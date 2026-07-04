/**
 * FIX (verification) — IG later-number upgrade path, end to end.
 *
 * An IG conversation that hits wedding intent with no phone creates a
 * placeholder lead (phone "ig:<senderId>", additionalInfo.awaitingNumber=true).
 * When a number arrives in a LATER inbound message, receiveMessage → ensureIgLead
 * (already-linked branch) → upgradeLeadWithPhone must upgrade the SAME lead in
 * place: phone → real number, awaitingNumber cleared.
 *
 * Drives the real receiveMessage with only the network deps mocked (Anthropic
 * queue + Instagram Graph). Seeds an isolated IG sender id and cleans up.
 *
 *   node tests/fix-ig-later-number.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

// ── Mock network deps BEFORE the service requires them (it destructures at load).
const igUtil = require("../utils/instagram");
igUtil.sendInstagramDM = async () => {};
igUtil.fetchInstagramProfile = async () => "Test IG Couple";

const queue = require("../utils/anthropicQueue");
// Extractor responses are classification:"lead"; phoneNumber is echoed only when
// a 10-digit number is visible in the conversation so far. Kiara replies are
// plain text. Returns the axios-style shape firstTextBlock expects.
queue.callAnthropic = async (opts) => {
  const sys = String((opts && opts.system) || "");
  if (sys.includes("data extractor")) {
    const blob = JSON.stringify((opts && opts.messages) || "");
    const m = blob.match(/\b(\d{10})\b/);
    const phoneNumber = m ? m[1] : "";
    const body = JSON.stringify({
      qualified: false,
      escalate: false,
      escalateReason: "",
      classification: "lead",
      data: {
        name: "Asha", phoneNumber, eventType: "wedding", city: "Bengaluru",
        eventDate: "", numberOfEvents: "", venueStatus: "", venueName: "",
        servicesRequired: "", budget: "", weddingStyle: "",
      },
    });
    return { data: { content: [{ type: "text", text: body }] } };
  }
  return { data: { content: [{ type: "text", text: "Sounds lovely! Tell me more 😊" }] } };
};

const { receiveMessage } = require("../services/InstagramAgentService");
const Enquiry = require("../models/Enquiry");
const WAConversation = require("../models/WAConversation");
const WAAgentMessage = require("../models/WAAgentMessage");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const igId = `igtest_${Date.now()}`;                 // non-numeric IG sender id
  const ten = `9${String(Date.now()).slice(-9)}`;       // unique 10-digit number
  const expectedFull = `91${ten}`;

  const findLead = () => Enquiry.findOne({ "additionalInfo.instagramId": igId }).lean();

  try {
    console.log("FIX — IG later-number upgrade (end to end)");

    // Three inbound messages with NO number → placeholder lead on the 3rd
    // (the userMessages >= 3 gate), awaitingNumber=true.
    await receiveMessage(igId, "Hi! Planning my wedding ✨");
    await receiveMessage(igId, "It's this December in Bangalore");
    await receiveMessage(igId, "We'd love full planning and decor");

    const placeholder = await findLead();
    ok(!!placeholder, "placeholder lead created on wedding intent (no phone yet)");
    ok(placeholder && String(placeholder.phone).startsWith("ig:"), "lead phone is the ig:<senderId> placeholder");
    ok(placeholder && placeholder.additionalInfo && placeholder.additionalInfo.awaitingNumber === true,
      "awaitingNumber === true before the number arrives");

    const placeholderId = placeholder && String(placeholder._id);

    // A LATER message carries the number → same lead upgraded in place.
    await receiveMessage(igId, `Sure, my number is ${ten}`);

    const upgraded = await findLead();
    ok(upgraded && String(upgraded._id) === placeholderId, "SAME lead upgraded (no duplicate created)");
    ok(upgraded && upgraded.phone === expectedFull, `lead phone upgraded to real number (${expectedFull})`);
    ok(upgraded && upgraded.additionalInfo && upgraded.additionalInfo.awaitingNumber === false,
      "awaitingNumber cleared to false after upgrade");
  } finally {
    await Enquiry.deleteMany({ "additionalInfo.instagramId": igId });
    await WAConversation.deleteMany({ phone: igId });
    await WAAgentMessage.deleteMany({ phone: igId });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

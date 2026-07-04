/**
 * WhatsApp activity logging — the cockpit/lead "WhatsApp" press must be recorded
 * as employee activity (a LeadInternalEvent, type 'whatsapp_outbound') so it
 * shows in the timeline and clears the "contacted but silent" flag — but it must
 * NOT satisfy the golden-window / "call owed" signal (firstCalledAt stays null).
 *
 *   node tests/whatsapp-activity.test.js
 *
 * Seeds an isolated, uniquely-tagged Enquiry against the local CRM DB and
 * cleans up (lead + its events) in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const CallCockpitService = require("../services/CallCockpitService");

const TAG = `wa-act-${Date.now()}`;
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const actorId = new mongoose.Types.ObjectId();
  let leadId = null;
  try {
    const lead = await Enquiry.create({
      name: "WA Activity Lead",
      phone: `${TAG}`,
      verified: false,
      isInterested: false,
      isLost: false,
      stage: "contacted",
      source: "Default",
    });
    leadId = lead._id;

    console.log("WhatsApp activity logging");
    ok(lead.firstCalledAt == null, "precondition: firstCalledAt is null before the press");

    const msg = "Hi Asha! This is Aarav from Wedsy — lovely chatting, here's a quick note.";
    const event = await CallCockpitService.logWhatsappActivity(leadId, { message: msg }, actorId);

    // A whatsapp_outbound event exists for the lead.
    const events = await LeadInternalEvent.find({ leadId, type: "whatsapp_outbound" }).lean();
    ok(events.length === 1, "exactly one whatsapp_outbound LeadInternalEvent recorded");
    ok(events[0] && String(events[0].actorId) === String(actorId), "event actorId is the acting admin");
    ok(events[0] && events[0].payload && events[0].payload.message === msg, "pre-typed message stored in payload");
    ok(event && (event.type === "whatsapp_outbound" || event.ok === true), "handler returns the created event");

    // The call clock is untouched: firstCalledAt still null, no callLog entry.
    const after = await Enquiry.findById(leadId).lean();
    ok(after.firstCalledAt == null, "firstCalledAt STILL null (does not satisfy golden / call owed)");
    ok((after.callLog || []).length === 0, "no callLog entry pushed");
  } finally {
    if (leadId) {
      await LeadInternalEvent.deleteMany({ leadId });
      await Enquiry.deleteMany({ _id: leadId });
    }
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

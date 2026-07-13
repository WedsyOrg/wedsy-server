// Journey v2 (V1) — the canonical lead brief + the qualifier-note feed it is
// distilled from.
//
// WHERE QUALIFIER NOTES ACTUALLY LIVE (audited):
//   1. Enquiry.qualifierNotes — a single legacy STRING (the qualification
//      screen's free-text box). No author/timestamp of its own.
//   2. LeadInternalEvent type "commented" — every structured note (AddNote and
//      the chat/note mirrors write these) with actorId + createdAt + payload.text.
//   3. qualificationData.additionalNotes — the cockpit's discovery notes string.
// The feed returns all three, notes limited to PRE-QUALIFICATION authorship
// (createdAt <= qualifiedAt) when the lead has a qualifiedAt — the brief is
// distilled from what the QUALIFIER knew; post-qual notes belong to the lanes.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadStep = require("../models/LeadStep");
const LeadInternalEventService = require("./LeadInternalEventService");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const qualifierNoteFeed = async (leadId) => {
  const lead = await Enquiry.findById(leadId, {
    qualifierNotes: 1, qualificationData: 1, qualifiedAt: 1, createdAt: 1, updatedAt: 1,
  }).lean();
  if (!lead) throw httpError(404, "Enquiry not found");

  const cutoff = lead.qualifiedAt ? new Date(lead.qualifiedAt) : null;
  const eventQuery = {
    leadId: lead._id,
    type: "commented",
    ...(cutoff ? { createdAt: { $lte: cutoff } } : {}),
  };
  const events = await LeadInternalEvent.find(eventQuery, {
    actorId: 1, createdAt: 1, payload: 1,
  })
    .sort({ createdAt: 1 })
    .lean();

  const authorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean).map(String))];
  const authors = authorIds.length
    ? await Admin.find({ _id: { $in: authorIds } }, { name: 1 }).lean()
    : [];
  const nameOf = new Map(authors.map((a) => [String(a._id), a.name]));

  const feed = [];
  if (lead.qualifierNotes && lead.qualifierNotes.trim()) {
    feed.push({ text: lead.qualifierNotes.trim(), author: null, when: null, source: "qualifier" });
  }
  if (lead.qualificationData && (lead.qualificationData.additionalNotes || "").trim()) {
    feed.push({
      text: lead.qualificationData.additionalNotes.trim(),
      author: null,
      when: null,
      source: "discovery",
    });
  }
  for (const e of events) {
    const text = e.payload && e.payload.text;
    if (!text) continue;
    feed.push({
      text: String(text),
      author: e.actorId ? nameOf.get(String(e.actorId)) || "—" : null,
      when: e.createdAt,
      source: "note",
    });
  }
  return feed;
};

// PUT /enquiry/:_id/lead-brief — the deliberate human save (never AI-auto).
const saveBrief = async (leadId, text, actorId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid enquiry id");
  const clean = String(text || "").trim();
  if (!clean) throw httpError(400, "A brief needs text");
  if (clean.length > 4000) throw httpError(400, "Briefs are capped at 4000 characters");
  const lead = await Enquiry.findById(leadId, { name: 1 }).lean();
  if (!lead) throw httpError(404, "Enquiry not found");

  const leadBrief = { text: clean, savedBy: actorId || null, savedAt: new Date() };
  // Whitelisted write — never a whole-doc save.
  await Enquiry.updateOne({ _id: leadId }, { $set: { leadBrief } });

  // Journey event (fire-safe inside the service contract of the caller).
  await LeadInternalEventService.record({
    leadId,
    type: "lead_brief_saved",
    actorId: actorId || null,
    payload: { length: clean.length },
  });

  // Auto-complete any kickoff checklist item FOR THE BRIEF: a LeadStep whose
  // name mentions the brief / qualifier-notes review. Generic name-match — no
  // new checklist machinery invented. Whitelisted updateMany.
  try {
    await LeadStep.updateMany(
      {
        leadId,
        status: { $ne: "complete" },
        name: { $regex: "brief|qualifier note", $options: "i" },
      },
      { $set: { status: "complete", completedAt: new Date() } }
    );
  } catch (e) {
    console.error("[LeadBrief] kickoff step auto-complete failed:", e.message);
  }
  // Kickoff lane echo (fire-safe no-op when the lane engine isn't live here).
  await require("./LeadLaneService").autoEntry(
    leadId,
    "kickoff",
    "brief_saved",
    "Lead brief saved & pinned"
  );

  return { leadBrief };
};

module.exports = { qualifierNoteFeed, saveBrief };

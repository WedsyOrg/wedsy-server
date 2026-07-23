// N1 — ONE NOTE STREAM. The audited truth: notes on a lead live in FIVE
// stores (see the N0 audit). This service merges them at READ time into one
// chronological stream — verbatim, nothing filtered, nothing migrated:
//   · LeadInternalEvent "commented"   — THE CANONICAL store (author + time)
//   · Enquiry.updates.conversations[] — the pre-qual comms tab (text + time,
//     NO author). Rows that a commented event links (payload.conversationId)
//     are skipped here — the canonical event carries them with authorship.
//   · Enquiry.qualifierNotes          — legacy single string (no author/time)
//   · Enquiry.qualificationData.additionalNotes — cockpit discovery string
//   · Enquiry.updates.notes           — the legacy blob (one verbatim entry;
//     it mirrors addNote appends, so its lines can repeat canonical notes —
//     included anyway: "nothing dropped" outranks de-dup elegance)
// Source labels: pre-qual | qualifier | post-qual — "qualifier" marks the
// qualifier stores; dated notes split pre-/post- on qualifiedAt.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const listNotes = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, {
    updates: 1, qualifierNotes: 1, "qualificationData.additionalNotes": 1, qualifiedAt: 1,
  }).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const events = await LeadInternalEvent.find(
    { leadId, type: "commented" },
    { actorId: 1, createdAt: 1, payload: 1 }
  ).lean();

  const authorIds = [...new Set(events.map((e) => String(e.actorId || "")).filter(Boolean))];
  const authors = authorIds.length ? await Admin.find({ _id: { $in: authorIds } }, { name: 1 }).lean() : [];
  const nameOf = new Map(authors.map((a) => [String(a._id), a.name]));

  // Source semantics: "qualifier" is reserved for the qualifier STORES
  // (qualifierNotes / additionalNotes — literally the qualifier's notes).
  // Dated notes split by era: at ≤ qualifiedAt (or never qualified) →
  // "pre-qual", after → "post-qual".
  const qualifiedAt = lead.qualifiedAt ? +new Date(lead.qualifiedAt) : null;
  const eraOf = (at) => {
    if (!qualifiedAt) return "pre-qual";
    return +new Date(at) <= qualifiedAt ? "pre-qual" : "post-qual";
  };

  const notes = [];
  const conversations = (lead.updates && lead.updates.conversations) || [];
  // authorship lent by a linking event: conversationId → event
  const eventByConvId = new Map();
  for (const e of events) {
    const convId = e.payload && e.payload.conversationId;
    if (convId) eventByConvId.set(String(convId), e);
  }
  // Events WITHOUT a conversation link = legacy addNote rows (pre-mirror era):
  // the event IS the note. Linked events whose subdoc row was deleted are
  // dropped — the delete removed the note; the append-only event just lends
  // authorship while its subdoc row lives.
  for (const e of events) {
    const convId = e.payload && e.payload.conversationId;
    // Linked events never render directly: live subdoc → rendered below;
    // deleted subdoc → the note stays deleted.
    if (convId) continue;
    const text = e.payload && e.payload.text;
    if (!text || !String(text).trim()) continue;
    const at = (e.payload && e.payload.at) || e.createdAt;
    notes.push({
      _id: String(e._id),
      text: String(text),
      authorId: e.actorId ? String(e.actorId) : null,
      authorName: e.actorId ? nameOf.get(String(e.actorId)) || null : null,
      at,
      source: eraOf(at),
    });
  }
  // Conversation subdocs: text/time are THE truth here (edits land here);
  // a linking event contributes the authorship the subdoc schema never held.
  for (const c of conversations) {
    if (!c || !String(c.text || "").trim()) continue;
    const linked = eventByConvId.get(String(c._id)) || null;
    const at = c.createdAt || null;
    notes.push({
      _id: String(c._id),
      text: String(c.text),
      authorId: linked && linked.actorId ? String(linked.actorId) : null,
      authorName: linked && linked.actorId ? nameOf.get(String(linked.actorId)) || null : null,
      at,
      source: at ? eraOf(at) : "pre-qual",
    });
  }
  if (lead.qualifierNotes && lead.qualifierNotes.trim()) {
    notes.push({
      _id: `qualifier-notes-${leadId}`,
      text: lead.qualifierNotes.trim(),
      authorId: null, authorName: null,
      at: lead.qualifiedAt || null,
      source: "qualifier",
    });
  }
  const disc = lead.qualificationData && lead.qualificationData.additionalNotes;
  if (disc && String(disc).trim()) {
    notes.push({
      _id: `discovery-notes-${leadId}`,
      text: String(disc).trim(),
      authorId: null, authorName: null,
      at: lead.qualifiedAt || null,
      source: "qualifier",
    });
  }
  if (lead.updates && lead.updates.notes && lead.updates.notes.trim()) {
    notes.push({
      _id: `notes-blob-${leadId}`,
      text: lead.updates.notes.trim(),
      authorId: null, authorName: null,
      at: null,
      source: "pre-qual",
    });
  }

  // Newest first; undated legacy entries sink to the bottom.
  notes.sort((a, b) => (b.at ? +new Date(b.at) : -Infinity) - (a.at ? +new Date(a.at) : -Infinity));
  return notes;
};

module.exports = { listNotes };

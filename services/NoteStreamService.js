// N1 — ONE NOTE STREAM. Merges every place a human typed a note into one
// chronological stream at READ time — verbatim, no migration. THE definition
// of a note (stream-purity ruling) is exactly these four sources:
//   · LeadInternalEvent "commented"   — THE CANONICAL store (author + time)
//   · Enquiry.updates.conversations[] — the pre-qual comms tab (text + time,
//     NO author). Rows that a commented event links (payload.conversationId)
//     are skipped here — the canonical event carries them with authorship.
//   · Enquiry.qualifierNotes + qualificationData.additionalNotes — the
//     discovery/qualification screens' strings (no author/time of their own)
//   · LeadChatMessage ritual-prefixed rows ("[Kickoff|Meetings|Lead comms|
//     Proposal|Agreement|Onboard] …") — notes the journey strip misrouted into
//     internal chat (prefix stripped; hidden from the rail + unread count)
// EXCLUDED as non-notes (stream-purity ruling):
//   · auto-composed call-result lines the cockpit fires through POST /note
//     ("Discovery call — result: …" — see AUTO_NOTE_RES)
//   · the legacy Enquiry.updates.notes blob — EXCEPT its orphan segments:
//     content the orphan check proves exists in no other store surfaces as
//     its own row (mirror segments never do; a pure mirror contributes 0)
//   · callLog[].notes, MOMs, lane threads, system chat rows — never included
// Source labels: pre-qual | qualifier | post-qual — "qualifier" marks the
// qualifier stores; dated notes split pre-/post- on qualifiedAt.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");

// Misrouted ritual notes: the journey "Notes & tasks" strip POSTs them to the
// internal-chat endpoint prefixed with the ritual's name — "[Kickoff] …",
// "[Meetings] …", "[Lead comms] …", "[Proposal] …", "[Agreement] …",
// "[Onboard] …". LeadChatService hides every one of them from the rail (via the
// same anchored regex); they are surfaced HERE at read time instead — the
// prefix stripped, author + time taken from the message row. No migration.
const { RITUAL_NOTE_PREFIX_RE, stripRitualNotePrefix } = require("../utils/ritualNotePrefixes");

// Auto-generated texts that reach the note stores through the /note endpoint
// but are NOT typed notes. Today that's the cockpit's fire-and-forget
// call-outcome stamp (CallCockpit.logDiscoveryResult — em-dash, anchored).
// Matched rows are dropped from the stream wherever they surface (the event
// AND its conversations mirror carry the same text).
const AUTO_NOTE_RES = [/^Discovery call — result: /];
const isAutoNote = (text) => AUTO_NOTE_RES.some((re) => re.test(String(text)));

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

// ── Blob-orphan detection (shared with scripts/audit-notes-blob-orphans.js) ──
// The updates.notes blob is mostly the addNote mirror, but pre-OS leads carry
// single-blob notes that exist NOWHERE else. Those orphan segments — and only
// those — surface in the stream; mirror segments never do.
const DATE_PREFIX_RE = /^\[([^\]\n]{4,24})\]\s*/; // "[9 Jul 2026] " addNote stamps
const normText = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// blob → [{ text, at }] — "\n\n"-separated segments, the date prefix stripped
// into `at` when parseable (else at:null and the segment stays verbatim).
const splitBlobSegments = (blob) =>
  String(blob || "")
    .split(/\n{2,}/)
    .map((raw) => {
      const seg = raw.trim();
      if (!seg) return null;
      const m = seg.match(DATE_PREFIX_RE);
      if (m) {
        const parsed = new Date(m[1]);
        if (!Number.isNaN(parsed.getTime())) return { text: seg.slice(m[0].length).trim(), at: parsed };
      }
      return { text: seg, at: null };
    })
    .filter((s) => s && s.text);

// Covered = the segment already lives in another store (exact or containment
// either way — catches partial mirrors and merged appends).
const isCoveredBy = (knownNormSet, text) => {
  const n = normText(text);
  if (!n) return true;
  if (knownNormSet.has(n)) return true;
  for (const k of knownNormSet) if (k.includes(n) || n.includes(k)) return true;
  return false;
};

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

  // Misrouted ritual notes — "[Kickoff|Meetings|Lead comms|Proposal|Agreement|
  // Onboard] …" chat rows the journey strip produced. Real messages only (kind
  // "message"), never system rows. The regex is anchored, so a mid-body
  // "[Proposal]" mention is NOT pulled in.
  const chatNotes = await LeadChatMessage.find(
    { leadId, kind: "message", body: { $regex: RITUAL_NOTE_PREFIX_RE } },
    { authorId: 1, body: 1, createdAt: 1 }
  ).lean();

  const authorIds = [
    ...new Set(
      [...events.map((e) => e.actorId), ...chatNotes.map((m) => m.authorId)]
        .filter(Boolean)
        .map(String)
    ),
  ];
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
    if (isAutoNote(text)) continue; // call-outcome stamp, not a typed note
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
    if (isAutoNote(c.text)) continue; // the addNote mirror of a call stamp
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
  // Misrouted chat notes: the ritual prefix stripped, author + time from the
  // message row. These rows are hidden from the chat rail (LeadChatService) —
  // the stream is their one home now.
  for (const m of chatNotes) {
    const text = stripRitualNotePrefix(m.body);
    if (!text || isAutoNote(text)) continue;
    notes.push({
      _id: String(m._id),
      text,
      authorId: m.authorId ? String(m.authorId) : null,
      authorName: m.authorId ? nameOf.get(String(m.authorId)) || null : null,
      at: m.createdAt,
      source: eraOf(m.createdAt),
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
  // Blob ORPHANS only: a segment of updates.notes surfaces IFF it exists in
  // no other store (mirror segments — the addNote "[date] …" appends — never
  // render; a pure-mirror blob contributes nothing). Coverage is checked
  // against RAW store texts (auto stamps included): a blob line mirroring an
  // excluded stamp is still a mirror, not an orphan.
  if (lead.updates && lead.updates.notes && lead.updates.notes.trim()) {
    const known = new Set();
    const addKnown = (t) => { const n = normText(t); if (n) known.add(n); };
    for (const c of conversations) addKnown(c && c.text);
    for (const e of events) addKnown(e.payload && e.payload.text);
    for (const m of chatNotes) addKnown(stripRitualNotePrefix(m.body));
    addKnown(lead.qualifierNotes);
    addKnown(disc);
    splitBlobSegments(lead.updates.notes).forEach((seg, i) => {
      if (isCoveredBy(known, seg.text)) return;
      notes.push({
        _id: `notes-blob-${leadId}-${i}`,
        text: seg.text,
        authorId: null, authorName: null, // the blob never held authorship
        at: seg.at,
        source: seg.at ? eraOf(seg.at) : "pre-qual",
      });
    });
  }

  // Newest first; undated legacy entries sink to the bottom.
  notes.sort((a, b) => (b.at ? +new Date(b.at) : -Infinity) - (a.at ? +new Date(a.at) : -Infinity));
  return notes;
};

module.exports = { listNotes, splitBlobSegments, isCoveredBy, normText };

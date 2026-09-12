/**
 * utils/venueDocNotes.js — notes that PRINT on a document.
 *
 * One parse and one carry-forward rule, shared by every generator, so no two
 * kinds can grow different ideas of what a note is.
 *
 * THE SHAPE: { numbered: boolean, lines: string[] }. Lines are A LIST and the
 * numbers are derived at render — never baked into the text. Deleting a
 * middle note renumbers the rest, and the printed numbers cannot drift from
 * the stored ones (the instalment-renumbering rule). No limit on count or
 * length, by ruling.
 *
 * THE CARRY-FORWARD: notes belong to the document they were written on, and a
 * new version of the SAME KIND starts from the previous version's notes —
 * retyping three notes is the friction that stops the feature being used. A
 * body that OMITS docNotes inherits; a body that sends docNotes (even with
 * empty lines) states the notes exactly. So an owner who cleared every line
 * gets a clean document, not a resurrection.
 */
const VenueLeadDocument = require("../models/VenueLeadDocument");

/** Validate the body's docNotes. Returns {ok, value} or {ok:false, message}. */
function parseDocNotes(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "docNotes must be an object: { numbered, lines }" };
  }
  if (!Array.isArray(raw.lines)) return { ok: false, message: "docNotes.lines must be a list of strings" };
  const lines = [];
  for (const l of raw.lines) {
    if (typeof l !== "string") return { ok: false, message: "docNotes.lines must be a list of strings" };
    const t = l.trim();
    if (t) lines.push(t);
  }
  return { ok: true, value: { numbered: Boolean(raw.numbered), lines } };
}

/**
 * The notes this generation should carry: the body's own when it sent any,
 * else the latest same-kind document's (survival across regeneration).
 */
async function resolveDocNotes(bodyValue, { enquiry, kind }) {
  if (bodyValue !== undefined) return bodyValue;
  const prev = await VenueLeadDocument.findOne({ enquiry, kind })
    .sort({ version: -1 })
    .select("docNotes")
    .lean();
  if (prev && prev.docNotes && Array.isArray(prev.docNotes.lines) && prev.docNotes.lines.length) {
    return { numbered: Boolean(prev.docNotes.numbered), lines: prev.docNotes.lines };
  }
  return undefined;
}

module.exports = { parseDocNotes, resolveDocNotes };

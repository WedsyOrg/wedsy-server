// ── THE GOOGLE CHAT MESSAGES, IN ONE PLACE ─────────────────────────────────
// The same idea as wedsy-crm's waMessages.ts, and for the same reason: these
// are the words a person actually reads, and they are the part of this feature
// most likely to be reworded. Keeping them out of the transport means the
// wording can change without anyone going near the HTTP call, the secret, or
// the fire-and-forget contract.
//
// PURE. Everything arrives as an argument. No env, no database, no clock — so
// the words can be asserted directly, and the same inputs always produce the
// same output.
//
// THE WORDING IS PROVISIONAL. Make posts a message for this today and its exact
// text is coming; this is the shape, deliberately isolated so matching or
// bettering that wording is an edit to one function and nothing else.

/** A number a person can act on.
 *
 *  DELIBERATELY UNMASKED, and this is not an oversight. Masking was removed
 *  OS-wide because it hid the number from the only people who needed to read
 *  it while protecting nothing — the full number was always on the client. The
 *  whole point of this ping is that someone can copy the number into a dialer
 *  within seconds of the lead landing, so it appears whole. */
const displayPhone = (phone) => String(phone || "").trim() || "no number";

/**
 * The new-lead ping.
 *
 * Ordered by what the reader does with it: WHO it is, HOW to reach them, then
 * the context (where they came from, whose lead it is), then the way in. The
 * name leads because that is what someone scanning a busy room of messages
 * recognises; the link is last because it is the thing they click after
 * deciding to act, not before.
 *
 * @param {object}  args
 * @param {string}  args.name             the lead's name as captured
 * @param {string}  args.phone            full number, unmasked
 * @param {string}  args.source           stored lead source, verbatim
 * @param {?string} args.assignedToName   null when it landed in triage
 * @param {string}  args.leadUrl          deep link, already built by the caller
 * @returns {string}
 */
function newLeadChatMessage({ name, phone, source, assignedToName, leadUrl }) {
  const who = String(name || "").trim() || "Unnamed lead";
  // An unassigned lead is not a broken one — it is in triage and needs someone
  // to grab it, which is a DIFFERENT call to action. Saying "Assigned to: null"
  // would be both ugly and wrong, so the line changes rather than the value.
  const ownership = assignedToName
    ? `Assigned to ${assignedToName}`
    : "Unassigned — sitting in triage, grab it";
  const where = String(source || "").trim();

  return [
    `🔔 New lead: ${who}`,
    `📞 ${displayPhone(phone)}`,
    where ? `📍 Source: ${where}` : null,
    `👤 ${ownership}`,
    `🔗 ${leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { newLeadChatMessage, displayPhone };

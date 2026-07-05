/**
 * utils/venueChatFlags.js — MB-V2 D4 keyword-flag routing.
 *
 * Terms come from env (VENUE_CHAT_FLAG_TERMS, comma-separated) so ops can tune
 * them without a deploy. Matching is case-insensitive substring over the
 * message text. Empty/unset env = feature dormant (no message ever flags).
 */
function flagTerms() {
  const raw = process.env.VENUE_CHAT_FLAG_TERMS || "";
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Returns the distinct configured terms that appear in `text`.
function matchFlagTerms(text) {
  if (!text || typeof text !== "string") return [];
  const hay = text.toLowerCase();
  const hits = [];
  for (const term of flagTerms()) {
    if (hay.includes(term) && !hits.includes(term)) hits.push(term);
  }
  return hits;
}

// SLA window (hours the venue may stay silent before it's a breach).
function slaHours() {
  const n = parseInt(process.env.VENUE_CHAT_SLA_HOURS || "24", 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

module.exports = { flagTerms, matchFlagTerms, slaHours };

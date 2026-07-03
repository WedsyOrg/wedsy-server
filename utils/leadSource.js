// Canonical lead-source buckets — the ONE implementation shared by the list's
// ?source= filter (regex fragments in buildBaseQuery) and the read-time
// `sourceChannel` decoration. The stored free-text `source` is NEVER rewritten;
// everything here is derive-on-read.
//
// SOURCE_PATTERNS is the long-standing filter vocabulary (moved verbatim from
// controllers/enquiry.js — the ?source= filter behavior is unchanged).
const SOURCE_PATTERNS = {
  whatsapp: "whatsapp",
  kiara: "kiara",
  instagram: "instagram|(^|[^a-z])ig([^a-z]|$)",
  facebook: "facebook|(^|[^a-z])fb([^a-z]|$)|meta",
  website: "web|site|default|form|landing|direct",
  repeated: "repeat",
};

// Ads wording ("Google Ads", "Ads (Landing Screen)") has no filter bucket —
// recognized by the CHANNEL decoration only.
const ADS_PATTERN = "(^|[^a-z])ads?([^a-z]|$)|google";

// Channel precedence: a specific channel outranks the broad website bucket
// ("Landing Screen | Ads (Google & Facebook)" is ads, not website — 'landing'
// would match the website words too). kiara maps to its underlying channel:
// the agent talks on the WhatsApp line. facebook/google/ads fold into "ads".
// `repeated` is a behaviour, not a channel — deliberately absent here.
const CHANNEL_RULES = [
  ["whatsapp", SOURCE_PATTERNS.whatsapp],
  ["whatsapp", SOURCE_PATTERNS.kiara],
  ["instagram", SOURCE_PATTERNS.instagram],
  ["ads", SOURCE_PATTERNS.facebook],
  ["ads", ADS_PATTERN],
  ["website", SOURCE_PATTERNS.website],
].map(([channel, pattern]) => [channel, new RegExp(pattern, "i")]);

// website | instagram | whatsapp | ads | other — from the messy stored text
// (source first, marketingSource as fallback). Empty/unmatched → "other".
const sourceChannelOf = (source, marketingSource) => {
  const s = String(source || marketingSource || "");
  if (!s.trim()) return "other";
  for (const [channel, re] of CHANNEL_RULES) {
    if (re.test(s)) return channel;
  }
  return "other";
};

module.exports = { SOURCE_PATTERNS, sourceChannelOf };

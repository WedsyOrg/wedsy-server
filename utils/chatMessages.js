// ── THE GOOGLE CHAT MESSAGES, IN ONE PLACE ─────────────────────────────────
// The same idea as wedsy-crm's waMessages.ts, and for the same reason: these
// are the words a person actually reads, and they are the part of this feature
// most likely to be reworded. Keeping them out of the transport means the
// wording can change without anyone going near the HTTP call, the secret, or
// the fire-and-forget contract.
//
// PURE. Everything arrives as an argument or is derived from the lead document
// passed in. No env, no database, no clock, no network — so the words can be
// asserted directly, and the same inputs always produce the same output.
//
// THIS FIRES FOR EVERY SOURCE, and the sources do not carry the same fields:
//
//   ad form       name, phone, source, form answers
//   WhatsApp      name + phone from the WA profile, no answers
//   Instagram DM  an instagramId and OFTEN NO PHONE — the stored `phone` is the
//                 placeholder "ig:<senderId>", which is not a number
//   website       name + phone
//   signup        name + phone
//
// So the message SHOWS WHAT EXISTS AND OMITS WHAT DOES NOT. A label with
// nothing after it is worse than a missing line: it reads as a system that
// lost the value rather than one that never had it.
//
// THE WORDING IS PROVISIONAL. Make posts a message for this today and its exact
// text is coming; this is the shape, deliberately isolated so matching or
// bettering that wording is an edit to this file and nothing else.
const { isPlaceholder } = require("./phone");

// The Meta ad / organic distinction is NOT redefined here. metaAdOrigin() is
// the rule — bare "instagram" WITH additionalInfo.instagramId is an organic DM,
// without it is an ad — and it already decides which leads are reported to
// Meta's Conversions API. A private second copy would drift from that one, and
// the two disagreeing would mean the ping says "ad" about a lead the CAPI
// deliberately withheld. So the label FOLLOWS metaAdOrigin rather than
// paralleling it.
//
// The dependency points utils -> services, which is unusual. It is the lesser
// evil: the alternative is duplicating a rule whose whole value is being
// singular. metaAdOrigin is itself pure, so this stays pure.
const { metaAdOrigin } = require("../services/MetaConversionsService");

/** Title-case a raw campaign slug: "facebook_june_decor" -> "Facebook June Decor". */
const humanise = (slug) =>
  String(slug || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * The source, in words a person reads — not the raw stored string.
 *
 * PURE, and it takes the whole lead because the instagram distinction needs
 * additionalInfo, not just `source`.
 *
 * @param {object} lead  needs source, and additionalInfo for the IG split
 * @returns {string}
 */
function sourceLabel(lead = {}) {
  const raw = String(lead.source || "").trim();
  if (!raw) return "Unknown source";

  const lower = raw.toLowerCase();

  // Channels that are unambiguous from the stored value alone.
  if (lower === "whatsapp") return "WhatsApp";
  if (lower === "instagram dm") return "Instagram DM";
  if (lower === "landing_page") return "Landing page";
  if (lower === "website") return "Website";
  if (lower.startsWith("user signup")) return "User signup";
  if (lower === "vendor personal leads") return "Vendor personal lead";
  if (lower === "international signup") return "International signup";
  if (lower === "wedding requirements form") return "Wedding requirements form";

  // Everything ad-shaped goes through metaAdOrigin, which is what resolves the
  // "instagram" collision. eligible === it is a Meta ad lead.
  const origin = metaAdOrigin(lead);
  if (origin.eligible) {
    if (lower === "meta ads") return "Meta Ads";
    if (lower.startsWith("facebook")) {
      const campaign = raw.slice("facebook".length).replace(/^_/, "");
      return campaign ? `Facebook Ad — ${humanise(campaign)}` : "Facebook Ad";
    }
    if (lower.startsWith("instagram")) {
      const campaign = raw.slice("instagram".length).replace(/^_/, "");
      return campaign ? `Instagram Ad — ${humanise(campaign)}` : "Instagram Ad";
    }
    return humanise(raw);
  }

  // Not a Meta ad. The one case worth naming explicitly is the organic DM,
  // because it shares its stored value with the ad case above.
  if (lower === "instagram") return "Instagram DM";
  if (lower === "ads (landing screen)") return "Ads (landing screen)";
  return humanise(raw);
}

/** A number a person can act on, or null when there isn't one.
 *
 *  DELIBERATELY UNMASKED when it exists: masking was removed OS-wide because it
 *  hid the number from the only people who needed to read it, and the point of
 *  this ping is dialling within seconds.
 *
 *  RETURNS NULL RATHER THAN A STAND-IN. "ig:<senderId>" is Instagram's no-number
 *  placeholder, not a phone; printing it next to a 📞 would send someone to
 *  dial a sender id. An empty phone is the same problem with less disguise. In
 *  both cases the caller omits the line entirely. */
const displayPhone = (phone) => {
  const raw = String(phone || "").trim();
  if (!raw || isPlaceholder(raw)) return null;
  return raw;
};

/**
 * The new-lead ping.
 *
 * Ordered by what the reader does with it: WHO it is, HOW to reach them, then
 * the context (where they came from, whose lead it is), then the way in. The
 * name leads because that is what someone scanning a busy room of messages
 * recognises; the link is last because it is what they click after deciding to
 * act, not before.
 *
 * Every line except the name, source, ownership and link is CONDITIONAL.
 *
 * @param {object}  args
 * @param {string}  args.name            the lead's name as captured
 * @param {?string} args.phone           raw stored value; omitted if unusable
 * @param {string}  args.sourceLabel     already humanised — sourceLabel(lead)
 * @param {?string} args.assignedToName  null when it landed in triage
 * @param {string}  args.leadUrl         deep link, already built by the caller
 * @param {?string} [args.instagramId]   shown when there is no phone to show
 * @returns {string}
 */
function newLeadChatMessage({ name, phone, sourceLabel: label, assignedToName, leadUrl, instagramId = null }) {
  const who = String(name || "").trim() || "Unnamed lead";
  const dialable = displayPhone(phone);
  // An unassigned lead is not a broken one — it is in triage and needs someone
  // to grab it, which is a DIFFERENT call to action. "Assigned to: null" would
  // be both ugly and wrong, so the line changes rather than the value.
  const ownership = assignedToName
    ? `Assigned to ${assignedToName}`
    : "Unassigned — sitting in triage, grab it";
  const where = String(label || "").trim();

  return [
    `🔔 New lead: ${who}`,
    dialable ? `📞 ${dialable}` : null,
    // Only worth a line when there is no phone: for a lead we CAN call, the
    // Instagram id is noise. For one we cannot, it is the only way to reach them.
    !dialable && instagramId ? `📷 Instagram ID: ${instagramId}` : null,
    where ? `📍 ${where}` : null,
    `👤 ${ownership}`,
    `🔗 ${leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { newLeadChatMessage, sourceLabel, displayPhone, humanise };

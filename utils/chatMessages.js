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
// THE WORDING IS SETTLED (approved 2026-09-10) — this shape IS the wording,
// not a placeholder for text arriving later. It stays isolated here anyway, for
// the reason it always was: the next reword should touch this file and nothing
// else.
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

// ── WHEN "CALL NOW" IS ACTUALLY TRUE ───────────────────────────────────────
// TWO conditions, and both are required.
//
// 1. THE SOURCE MUST BE COLD. An ad or website lead is silent — nobody has
//    spoken to them, so the five minutes is real. A WhatsApp or Instagram DM
//    lead is the opposite: Kiara is ALREADY replying, and "call within 5
//    minutes" would have a rep interrupt a conversation that is going fine.
//
// 2. THERE MUST BE A NUMBER TO DIAL. This was the missing half. Scoping the
//    rule to source alone put 🚨 and "⚡ Call within 5 minutes" on a WEBSITE
//    lead with no phone — the same objection raised against Instagram DM,
//    arriving through a different door, because the real precondition was never
//    the source. It is whether the instruction can be followed.
//
// An alert that promises an action nobody can take is worse than no alert:
// firing 🚨 on leads that cannot be called is how a team learns the marker
// means nothing, which then costs the ad leads where it did matter.
//
// Kiara's line is deliberately NOT subject to condition 2. It describes the
// CONVERSATION, not the phone, and it is equally true on an Instagram DM lead
// that has no number at all.
const KIARA_ENGAGED = new Set(["WhatsApp", "Instagram DM"]);

/** "just now" / "2 min ago" / "3 h ago" / "2 d ago". Pure — `now` is injected. */
function relativeTime(from, now = new Date()) {
  if (!from) return null;
  const then = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(then.getTime())) return null;
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// A month BAND from an ad form ("between_3-6_months") is not a date — see the
// exclusion in DiscoveryService, which refuses to let one satisfy the discovery
// gate. It is still the most useful thing to show a rep at a glance, so it is
// phrased as the approximation it is.
const humaniseTimeline = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return null;
  const m = v.match(/^between_(\d+)-(\d+)_months?$/i);
  if (m) return `Wedding in ${m[1]}-${m[2]} months`;
  const b = v.match(/^beyond_(\d+)_months?$/i);
  if (b) return `Wedding beyond ${b[1]} months`;
  const w = v.match(/^within_(\d+)_months?$/i);
  if (w) return `Wedding within ${w[1]} months`;
  return humanise(v.replace(/_/g, " "));
};

// BEST-EFFORT READ of a free-form bucket. adFormAnswers is whatever the form
// sent, so the key names are not guaranteed — the first non-empty candidate
// wins and NOTHING is shown when none is found. That is the degrade rule: an
// absent 📍 line is honest, a "📍 " with nothing after it is not.
const LOCATION_KEYS = ["state", "city", "location", "area", "region"];
const TIMELINE_KEYS = ["eventMonth", "weddingDate", "eventDate", "timeline", "date"];
const firstOf = (answers, keys) => {
  for (const k of keys) {
    const v = answers && answers[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return null;
};

/**
 * The new-lead ping.
 *
 * Ordered by what the reader does with it: what kind of alert this is, WHO it
 * is, HOW to reach them, the context, whose it is and how fresh, what to do,
 * then the way in. The link is last because it is what they click after
 * deciding to act, not before.
 *
 * EVERY LINE EXCEPT THE HEADER, 👤, 🙋 AND 🔗 IS CONDITIONAL. A label with
 * nothing after it reads as a system that lost the value rather than one that
 * never had it, so a missing field removes its line entirely.
 *
 * The emoji names the field, so the labels Make carries ("Phone:", "Source:")
 * are dropped as redundant.
 *
 * @param {object}  args
 * @param {object}  args.lead             the lead document
 * @param {?string} args.assignedToName   null when it landed in triage
 * @param {string}  args.leadUrl          deep link, already built by the caller
 * @param {Date}    [args.now]            injected so the 🕒 line is testable
 * @returns {string}
 */
function newLeadChatMessage({ lead = {}, assignedToName, leadUrl, now = new Date() }) {
  const label = sourceLabel(lead);
  const engaged = KIARA_ENGAGED.has(label);

  const who = String(lead.name || "").trim() || "Unnamed lead";
  const dialable = displayPhone(lead.phone);
  // Both conditions — see the block above. A cold source with no number is not
  // urgent, it is just unreachable by phone.
  const urgent = !engaged && !!dialable;
  const answers = (lead.additionalInfo && lead.additionalInfo.adFormAnswers) || {};
  const instagramId = (lead.additionalInfo && lead.additionalInfo.instagramId) || null;

  const context = [firstOf(answers, LOCATION_KEYS), humaniseTimeline(firstOf(answers, TIMELINE_KEYS))]
    .filter(Boolean)
    .join(" · ");

  // An unassigned lead is not a broken one — it is in triage and needs someone
  // to grab it, which is a DIFFERENT call to action. "🙋 null" would be both
  // ugly and wrong, so the line changes rather than the value.
  const ownership = assignedToName
    ? String(assignedToName)
    : "Unassigned — sitting in triage, grab it";
  const when = relativeTime(lead.createdAt, now);

  return [
    `${urgent ? "🚨" : "🔔"} NEW LEAD — ${label}`,
    `👤 ${who}`,
    dialable ? `📞 ${dialable}` : null,
    // Only worth a line when there is no phone: for a lead we CAN call, the
    // Instagram id is noise. For one we cannot, it is the only way to reach them.
    !dialable && instagramId ? `📷 Instagram ID: ${instagramId}` : null,
    context ? `📍 ${context}` : null,
    `🙋 ${ownership}`,
    when ? `🕒 ${when}` : null,
    // Kiara's line whenever she is engaged, phone or not. The ⚡ only when the
    // call it demands is actually possible. Neither applies to a cold lead with
    // no number: there is no true call to action, so no line is invented — the
    // 🔗 is how they get to it.
    engaged ? "💬 Kiara is already replying" : urgent ? "⚡ Call within 5 minutes" : null,
    `🔗 ${leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { newLeadChatMessage, sourceLabel, displayPhone, humanise, relativeTime, humaniseTimeline };

/* META CONVERSIONS API — tell Meta when a lead actually QUALIFIES.
 *
 * Meta optimises for whatever we report back. Left alone it optimises for the
 * cheapest form fill, because a form fill is the last thing it hears about.
 * Reporting the qualification lets it optimise for leads the sales team can
 * actually work with.
 *
 *   POST https://graph.facebook.com/v25.0/{DATASET_ID}/events?access_token=…
 *
 * BOTH action_source "system_generated" AND custom_data.event_source "crm" are
 * required. Miss either and Meta does not treat the payload as a CRM lead
 * event at all — it is accepted and then quietly does nothing useful.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WE DO NOT SEND lead_id, AND THAT IS DELIBERATE.
 *
 * lead_id is Meta's preferred identifier and we do not have it: the Make
 * bridge consumes it and maps the AD ID into that field instead. Sending the
 * ad id as a lead_id would be a confidently wrong identifier, which is worse
 * than no identifier — Meta would either reject the event or attribute it to
 * the wrong thing. So we match on hashed contact details only.
 *
 * Plumbing the real lead_id through the bridge later is purely ADDITIVE: add
 * it to user_data and the matching improves. Nothing here has to change.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHICH LEADS. Because we match on a hashed phone rather than a lead_id, Meta
 * will cheerfully match a person who never saw an ad. Sending a website,
 * WhatsApp or walk-in lead would therefore credit organic business to the
 * campaigns and actively teach the algorithm to buy more of the wrong thing.
 * So the gate is an allow-list (META_AD_SOURCES below), never a deny-list, and
 * anything outside it is skipped with a logged reason — never silently.
 */
const crypto = require("crypto");

const API_VERSION = "v25.0";
const EVENT_NAME = "Qualified Lead";

// ── THE GATE ───────────────────────────────────────────────────────────────
// Only controllers/webhook.js resolveSource() emits these, and it is the sole
// entry point for the Make → OS Meta ad bridge. Campaign labels are open-ended
// (facebook_june_decor, instagram_promo, …) so the shape is matched, not a
// fixed list — this mirrors META_SOURCE_RE in that controller.
//
// NOTE THE SUFFIX REQUIREMENT ON instagram. Bare "instagram" is AMBIGUOUS:
// resolveSource lowercases an Instagram ad campaign to it, and
// services/InstagramAgentService.js independently stores every ORGANIC
// Instagram DM lead as exactly the same string. Same value, two origins, and
// one of them must never be sent. isMetaAdSource therefore treats bare
// "instagram" as eligible ONLY when the DM agent's fingerprint
// (additionalInfo.instagramId, which only that service writes) is absent.
const META_AD_SOURCE_RE = /^(facebook|instagram)(_[a-z0-9]+)*$/;

// DELIBERATELY EXCLUDED, pending the production census
// (scripts/audit-lead-source-meta-origin.js):
//   "Ads (Landing Screen)" — resolveSource's DEFAULT when the bridge sends no
//       source at all. Its own comment calls it "the historical landing-page
//       default", so it holds a mix of real ad leads and plain landing-page
//       fills that cannot be told apart from the source string. Excluded
//       because a false send is unrecoverable — it trains the algorithm —
//       while a missed send merely costs signal we never had.
//   "landing_page" — the bridge's explicit non-ad value.
// Widening this set is a product decision, not a code cleanup.
const EXCLUDED_AMBIGUOUS = ["Ads (Landing Screen)", "landing_page"];

// Eligibility + the REASON, so a skip is always explainable in the log.
const metaAdOrigin = (lead = {}) => {
  const source = String(lead.source || "").trim();
  if (!source) return { eligible: false, reason: "no source on the lead" };
  if (EXCLUDED_AMBIGUOUS.includes(source)) {
    return { eligible: false, reason: `source "${source}" is ambiguous (ad vs landing page) — excluded pending census` };
  }
  if (!META_AD_SOURCE_RE.test(source)) {
    return { eligible: false, reason: `source "${source}" is not a Meta ad source` };
  }
  // The bare-"instagram" collision, resolved on the DM agent's own marker.
  if (source === "instagram" && lead.additionalInfo && lead.additionalInfo.instagramId) {
    return { eligible: false, reason: 'source "instagram" but additionalInfo.instagramId is set — organic DM, not an ad' };
  }
  return { eligible: true, reason: `source "${source}"` };
};

// ── HASHING, exactly as Meta specifies ─────────────────────────────────────
// Only em and ph are ever hashed, and neither is ever sent unhashed.
const sha256Hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

// em: trim, lowercase, SHA-256. Returns null when there is nothing to send.
const normaliseEmail = (raw) => {
  const trimmed = String(raw || "").trim().toLowerCase();
  // Not full RFC validation — just enough that we never hash an obvious
  // non-address into a junk identifier Meta will try to match on.
  if (!trimmed || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null;
  return trimmed;
};

// ph: strip symbols, letters and LEADING ZEROS; the country code MUST be
// present. Returns null when there is nothing trustworthy to send.
const normalisePhone = (raw) => {
  const original = String(raw || "").trim();
  // "ig:<sender id>" is InstagramAgentService's PLACEHOLDER for a lead that has
  // not shared a number yet. Stripping letters and symbols would turn it into a
  // 14-digit "phone number" and we would hash a fabricated identifier. Reject
  // it before normalisation, not after.
  if (/^ig:/i.test(original)) return null;
  const digits = original.replace(/[^0-9]/g, "").replace(/^0+/, "");
  if (!digits) return null;
  // A bare 10-digit number is an Indian local number with the country code
  // dropped — the same assumption toFullPhone() already makes at IG intake.
  // Meta requires the country code, so add it rather than send a number Meta
  // cannot match.
  if (digits.length === 10) return `91${digits}`;
  // Shorter than a local number is not a phone number; do not guess.
  if (digits.length < 10) return null;
  return digits;
};

// ── THE EVENT ──────────────────────────────────────────────────────────────
// event_id is a STABLE dedup key: the same lead qualifying twice derives the
// same id, so a retry — or a re-qualification that slipped past the caller's
// idempotency — is collapsed by Meta rather than double-counted.
const eventIdFor = (leadId) => `wedsyos-${EVENT_NAME.toLowerCase().replace(/\s+/g, "-")}-${leadId}`;

const buildEvent = (lead) => {
  const email = normaliseEmail(lead.email);
  const phone = normalisePhone(lead.phone);
  const user_data = {};
  const identifiers = [];
  if (email) { user_data.em = sha256Hex(email); identifiers.push("em"); }
  if (phone) { user_data.ph = sha256Hex(phone); identifiers.push("ph"); }

  // qualifiedAt is when qualification actually happened; Date.now() is only a
  // fallback for a caller that has not stamped it yet. Meta wants SECONDS.
  const at = lead.qualifiedAt ? new Date(lead.qualifiedAt) : new Date();
  return {
    identifiers,
    event: {
      event_name: EVENT_NAME,
      event_time: Math.floor(at.getTime() / 1000),
      action_source: "system_generated",
      event_id: eventIdFor(lead._id),
      user_data,
      custom_data: {
        event_source: "crm",
        lead_event_source: "Wedsy OS",
      },
    },
  };
};

// ── THE SEND ───────────────────────────────────────────────────────────────
// NEVER THROWS. Qualifying a lead must succeed even when Meta is down, so
// every failure path here resolves to a described result instead of raising.
// The caller does not await it.
const sendQualifiedLead = async (lead) => {
  const leadId = lead && lead._id ? String(lead._id) : "(unknown)";
  const log = (msg, extra = "") => console.log(`[MetaCAPI] lead=${leadId} ${msg}${extra ? " " + extra : ""}`);

  try {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    const token = process.env.META_CAPI_ACCESS_TOKEN;
    if (!datasetId || !token) {
      log("SKIPPED — META_CAPI_DATASET_ID / META_CAPI_ACCESS_TOKEN not configured");
      return { sent: false, reason: "not_configured" };
    }

    const origin = metaAdOrigin(lead);
    if (!origin.eligible) {
      // LOUD, not silent: this is the guard that keeps organic business out of
      // the campaigns, so every skip is explainable after the fact.
      log(`SKIPPED — not a Meta ad lead: ${origin.reason}`);
      return { sent: false, reason: "not_meta_sourced", detail: origin.reason };
    }

    const { event, identifiers } = buildEvent(lead);
    if (!identifiers.length) {
      log("SKIPPED — no hashable identifier (no usable phone, no email)");
      return { sent: false, reason: "no_identifiers" };
    }

    const body = { data: [event] };
    // When set, the event goes to Events Manager's Test Events view ONLY and
    // does not affect real data or optimisation.
    const testCode = process.env.META_CAPI_TEST_EVENT_CODE;
    if (testCode) body.test_event_code = testCode;

    // The token is a secret: it travels as a query parameter because that is
    // the API's contract, but the URL is NEVER logged — only the endpoint is.
    const endpoint = `https://graph.facebook.com/${API_VERSION}/${datasetId}/events`;
    log(
      `SENDING event="${event.event_name}" event_time=${event.event_time} event_id=${event.event_id}`,
      `identifiers=[${identifiers.join(",")}] via=${origin.reason}${testCode ? " (TEST EVENT)" : ""}`
    );

    const res = await fetch(`${endpoint}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON body — status still tells the story */ }

    if (!res.ok) {
      // fbtrace_id is what Meta support asks for; surface it or the failure is
      // undiagnosable.
      const err = (payload && payload.error) || {};
      log(
        `FAILED — HTTP ${res.status}`,
        `message="${err.message || "(none)"}" fbtrace_id=${err.fbtrace_id || "(none)"}`
      );
      return { sent: false, reason: "http_error", status: res.status, fbtrace_id: err.fbtrace_id || null };
    }

    log(`SENT — HTTP ${res.status} events_received=${(payload && payload.events_received) ?? "?"}`);
    return { sent: true, status: res.status, eventId: event.event_id };
  } catch (e) {
    // Network failure, DNS, abort — still not the qualification's problem.
    log(`FAILED — ${e.message}`);
    return { sent: false, reason: "exception", error: e.message };
  }
};

module.exports = {
  sendQualifiedLead,
  metaAdOrigin,
  buildEvent,
  normaliseEmail,
  normalisePhone,
  eventIdFor,
  EVENT_NAME,
  API_VERSION,
  META_AD_SOURCE_RE,
  EXCLUDED_AMBIGUOUS,
};

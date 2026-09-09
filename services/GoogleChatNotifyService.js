/* GOOGLE CHAT — the new-lead ping.
 *
 * Make owns this notification today, and the audit found no server code that
 * could replace it: nothing here posts to Google Chat at all. That gap is one
 * of the two things blocking Make's removal. This closes it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT SHIPS DORMANT, AND THAT IS THE POINT.
 *
 * MAKE IS STILL POSTING. Turning this on before Make's scenario is switched
 * off would double-notify the team on every single lead, which is a worse
 * outcome than the gap it closes — an alert people learn to ignore is an alert
 * that has stopped working. So it posts only when GOOGLE_CHAT_LEADS_WEBHOOK_URL
 * is set in the host .env. Unset, it logs a SKIPPED line and lead creation
 * proceeds exactly as it does today.
 *
 * The rollout is therefore: switch Make's Chat module off, THEN set the env
 * var. Never the other way round.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NEVER FAILS OR DELAYS A LEAD. The caller does not await it, and nothing in
 * here throws: every failure path resolves to a described result. A Chat outage
 * must never cost us a lead, which is the whole hierarchy of importance here —
 * the lead is the business, the ping is a convenience.
 *
 * THE WEBHOOK URL IS A SECRET. A Google Chat incoming-webhook URL carries its
 * own `key` and `token` query parameters: anyone holding it can post into the
 * space. So it is never logged, never interpolated into an error message, and
 * never included in a thrown exception — see redact() below, which every line
 * out of this file passes through.
 *
 * THE WORDS ARE NOT IN HERE. utils/chatMessages.js owns them.
 */
const { newLeadChatMessage } = require("../utils/chatMessages");

// The OS base, for the deep link. NEVER a literal URL: staging and production
// point at different hosts, and a hardcoded link would send the whole team to
// the wrong one. Matches the existing convention (controllers/auth.js:714,
// controllers/admin.js:98).
const osBase = () => String(process.env.OS_FRONTEND_URL || "https://os.wedsy.in").replace(/\/+$/, "");

/** The lead's page in the OS. */
const leadUrlFor = (leadId) => `${osBase()}/leads/${leadId}`;

// Strip the webhook URL — and anything shaped like its credentials — out of any
// string bound for a log. Belt and braces: the exact URL is removed, and so are
// key=/token= parameters generally, in case a different one ever reaches here.
const redact = (text) => {
  const url = process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL || "";
  let out = String(text == null ? "" : text);
  if (url) out = out.split(url).join("<webhook url redacted>");
  return out
    .replace(/([?&](?:key|token)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/https:\/\/chat\.googleapis\.com\/\S*/gi, "<webhook url redacted>");
};

const log = (msg) => console.log(redact(`[chat-notify] ${msg}`));

/**
 * Post the new-lead ping. NEVER THROWS.
 *
 * @param {object}  lead              needs _id, name, phone, source,
 *                                    and additionalInfo for the IG split
 * @param {object}  [opts]
 * @param {?string} [opts.assignedToName]  null when the lead is in triage
 * @returns {Promise<{sent: boolean, reason?: string, status?: number}>}
 */
const notifyNewLead = async (lead, { assignedToName = null } = {}) => {
  const leadId = lead && lead._id ? String(lead._id) : "(unknown)";
  try {
    const webhookUrl = process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL;
    if (!webhookUrl) {
      log(`SKIPPED lead=${leadId} — not configured (GOOGLE_CHAT_LEADS_WEBHOOK_URL unset). Make still owns this ping.`);
      return { sent: false, reason: "not_configured" };
    }
    if (!lead || !lead._id) {
      log("SKIPPED — no lead to describe");
      return { sent: false, reason: "no_lead" };
    }

    // The whole lead goes in: the message decides which lines it can fill from
    // what is actually there, and resolves the instagram ad/DM collision via
    // metaAdOrigin — see utils/chatMessages.js.
    const text = newLeadChatMessage({
      lead,
      assignedToName,
      leadUrl: leadUrlFor(leadId),
    });

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      // The body can echo the request back, so it goes through redact() too.
      let detail = "";
      try { detail = redact(String(await res.text()).slice(0, 300)); } catch { /* unreadable */ }
      log(`FAILED lead=${leadId} — HTTP ${res.status}${detail ? ` body="${detail}"` : ""}`);
      return { sent: false, reason: "http_error", status: res.status };
    }

    log(`SENT lead=${leadId} — HTTP ${res.status}`);
    return { sent: true, status: res.status };
  } catch (e) {
    // A network error's message routinely contains the URL it failed to reach.
    log(`FAILED lead=${leadId} — ${redact(e && e.message ? e.message : String(e))}`);
    return { sent: false, reason: "exception" };
  }
};

module.exports = { notifyNewLead, leadUrlFor, osBase };

const axios = require("axios");
const { nationalFor, leadingDigits, defaultCountryCode } = require("../utils/phone");
const NotificationFailureLog = require("../models/NotificationFailureLog");
const { Client: MailjetClient } = require("node-mailjet");

// ─── Trigger config ───────────────────────────────────────────────────────────
// Each trigger lists only the channels that should fire for that event.
// sms.senderId defaults to "WEDSYY" when omitted.
// send() fires all channels in parallel; callers do not need to await.
const TRIGGERS = {
  otp_std:                    { sms: { templateId: "178506" }, email: { templateId: 6647480 } },
  event_link:                 { sms: { templateId: "178493" }, metaTemplate: { name: "eventtool_link" } },
  user_event_create:          { whatsapp: { campaign: "user_event_create" }, email: { templateId: 6647516 } },
  event_Reciept:              { sms: { templateId: "178505", senderId: "XWEDSY" }, whatsapp: { campaign: "et_reciept" }, email: { templateId: 664758 } },
  event_pmnt_rmnd:            { sms: { templateId: "178507" }, whatsapp: { campaign: "et_pymnt_rmnd" }, email: { templateId: 6637087 } },
  et_inv:                     { sms: { templateId: "178496", senderId: "XWEDSY" }, whatsapp: { campaign: "et_invoice" }, email: { templateId: 6637124 } },
  mua_account_create_success: { email: { templateId: 6615723 } },
  mua_account_verify_success: { metaTemplate: { name: "mua_account_verify_success" }, email: { templateId: 6663019 } },
  mua_app_install:            { email: { templateId: 6663277 } },
  MUA_BID_REQS:               { sms: { templateId: "178495" }, metaTemplate: { name: "mua_bid_req" }, email: { templateId: 6621748 } },
  mua_bid_accept:             { sms: { templateId: "178502" }, metaTemplate: { name: "mua_bid_accept" }, email: { templateId: 6629142 } },
  MUA_BID_CONFRM:             { sms: { templateId: "178510" }, metaTemplate: { name: "mua_bid_cnfrm" }, email: { templateId: 6622160 } },
  MUA_PKG_REQS:               { sms: { templateId: "178513", senderId: "XWEDSY" }, metaTemplate: { name: "mua_pkg_req" }, email: { templateId: 6622127 } },
  MUA_PKG_CNFRM:              { sms: { templateId: "178514" }, metaTemplate: { name: "mua_pkg_cnfrm" }, email: { templateId: 6631081 } },
  MUA_PRSNL_PKG_REQS:         { sms: { templateId: "178509" }, metaTemplate: { name: "mua_prsnl_pkg_req" }, email: { templateId: 6622131 } },
  MUA_PRSNL_PKG_CONFRM:       { sms: { templateId: "178497" }, metaTemplate: { name: "mua_prsnl_pkg_cnfrm" }, email: { templateId: 6631200 } },
  // mua_new_chat: migrated off AiSensy to the Meta Cloud API (2 Sep 2026).
  // Template "mua_new_chat" (Utility, en, APPROVED) takes TWO body variables:
  //   {{1}} = the recipient's name, {{2}} = the other party's name.
  // Callers MUST pass variables: [recipientName, otherPartyName] — Meta rejects
  // a parameter-count mismatch with 400 #132000.
  mua_new_chat:               { metaTemplate: { name: "mua_new_chat" } },
  mua_rmnd_dminus1:           { metaTemplate: { name: "mua_rmnd_dminus1" } },
  mua_rmnd_d_day:             { metaTemplate: { name: "mua_rmnd_d_day" } },
  mua_settlement:             { metaTemplate: { name: "mua_settlement" }, email: { templateId: 6712689 } },
  Community_new_topic:        { email: { templateId: 6663336 } },
  Community_new_reply:        { email: { templateId: 6663362 } },
  mua_bday:                   { email: { templateId: 6713649 } },
  mua_task_reminder:          { whatsapp: { campaign: "mua_task_reminder" } },
  cust_bidreqs_send:          { sms: { templateId: "178498" }, metaTemplate: { name: "cust_bidreq_send" }, email: { templateId: 6636091 } },
  cust_bid_recieve:           { sms: { templateId: "178512" }, whatsapp: { campaign: "cx_bid_recieve" }, email: { templateId: 6636371 } },
  cx_custoffer_bid:           { sms: { templateId: "178511" }, whatsapp: { campaign: "cx_custoffer_bid" }, email: { templateId: 6636185 } },
  cx_bid_cnfrm:               { sms: { templateId: "178501" }, metaTemplate: { name: "cx_bid_cnfrm" }, email: { templateId: 6636379 } },
  cx_prslpkg_req_send:        { metaTemplate: { name: "cx_prslpkg_req_send" }, email: { templateId: 6631683 } },
  cust_prslpkg_accpt:         { sms: { templateId: "178499" }, metaTemplate: { name: "cust_prslpkg_accept" }, email: { templateId: 6636038 } },
  cust_prslpkg_dcln:          { sms: { templateId: "178503" }, metaTemplate: { name: "cust_prslpkg_reject" }, email: { templateId: 6647374 } },
  cx_pkg_cnfrm:               { sms: { templateId: "178494" }, metaTemplate: { name: "cx_pkg_cnfrm" }, email: { templateId: 6636798 } },
  cust_wedsy_pkg_refund:      { whatsapp: { campaign: "cust_wedsy_pkg_refund" }, email: { templateId: 6649243 } },
  cx_prsnl_pkg_cnfrm:         { sms: { templateId: "178500" }, whatsapp: { campaign: "cx_prsnl_pkg_cnfrm" }, email: { templateId: 6636905 } },
  cust_artist_detail:         { sms: { templateId: "178504" }, metaTemplate: { name: "cx_artist_detail" }, email: { templateId: 6636835 } },
  cx_mua_review:              { email: { templateId: 6637036 } },
  mua_review_app:             { whatsapp: { campaign: "mua_review_app" } },
  cx_pkg_review:              { whatsapp: { campaign: "cx_pkg_review" } },
  mua_cx_pmnt_rmnd_prsnl:     { metaTemplate: { name: "cx_pmnt_rmnd_prsnl" } },
  // user_signup_greet: the AiSensy campaign leg 400'd on every signup (provider
  // misconfiguration — same class as the disabled new_lead ping). Now sends via
  // the Meta WhatsApp Cloud API directly (utils/whatsapp.js).
  // ⚠️ The trigger id and the Meta template name DIFFER. The approved template in
  // WABA 1880312775963329 is "user_signup_greet_wedsy" (Marketing, en). A template
  // named "user_signup_greet" was never created, so this leg 400'd on every signup
  // until 2 Sep 2026. ONE body variable ({{1}} = the user's name).
  user_signup_greet:          { metaTemplate: { name: "user_signup_greet_wedsy" }, email: { templateId: 6637167 } },
  cust_booking_rmnd:          { sms: { templateId: "178508" }, metaTemplate: { name: "cust_booking_rmnd" }, email: { templateId: 6637515 } },

  // Legacy — old DLT template IDs / AiSensy campaigns used by utils/update.js before template migration
  // new_lead: NOT WIRED. The "New Lead" branch in utils/update.js is a deliberate
  // no-op — new-lead alerting is internal via AdminNotificationService. A Meta
  // template "new_lead" (Marketing, en, one body variable) was approved on
  // 2 Sep 2026 if this is ever re-enabled, but re-enabling is a product call.
  new_lead:      { sms: { templateId: "163269", senderId: "XWEDSY" }, whatsapp: { campaign: "user_lead" } },
  event_approved:{ metaTemplate: { name: "event_approval_confirm" } },
};

// ─── Channel senders ──────────────────────────────────────────────────────────

// SMS goes out through Fast2SMS on the `dlt` route. THAT GATEWAY IS INDIA-ONLY:
// DLT is TRAI's Indian registration regime, and Fast2SMS's own documentation
// states recipients are Indian ten-digit mobile numbers ("If your customers are
// outside India, this plugin is not for you"). Measured 2026-09-09, not assumed.
//
// So REFUSING an international destination is correct and stays. What was wrong
// was doing it in silence: `if (!phone.includes("+91")) return` dropped every
// international lead's SMS with nothing logged anywhere, so nobody could know it
// had happened, let alone how often.
//
// The national number is now DERIVED rather than string-replaced. The old
// `phone.replace("+91", "")` does nothing at all to "+971501234567" — that
// string does not contain "+91" — so a number that slipped past the guard would
// have been handed to the gateway with a "+" still in it.
//
// WhatsApp is unaffected and still goes to international numbers: AiSensy and
// the Meta Cloud API both take a full international destination. Only the SMS
// leg is India-bound.
function sendSMS(phone, templateId, variables = [], senderId = "WEDSYY", { leadId = null } = {}) {
  const who = `${leadId ? `lead=${leadId}` : "lead=(unknown)"} template=${templateId}`;
  if (!phone) {
    console.log(`[sms] SKIPPED — no phone. ${who}`);
    return Promise.resolve();
  }
  // The subscriber digits are NOT logged: a full mobile number identifies a
  // person, and a skip line does not need one to be actionable.
  const national = nationalFor(phone, defaultCountryCode());
  if (!national) {
    console.log(
      `[sms] SKIPPED — Fast2SMS delivers to ${defaultCountryCode()} numbers only; ` +
        `this number begins ${leadingDigits(phone) || "(unreadable)"}. ${who}`
    );
    return Promise.resolve();
  }
  console.log(`[sms] SENDING — ${who} to a +${defaultCountryCode()} number`);
  return axios({
    method: "post",
    url: process.env.FAST2SMS_API_URL,
    headers: {
      authorization: process.env.FAST2SMS_API_KEY,
      "Content-Type": "application/json",
    },
    data: JSON.stringify({
      route: "dlt",
      sender_id: senderId,
      message: templateId,
      variables_values: variables.join("|"),
      flash: 0,
      numbers: national,
    }),
  });
}

function sendWhatsApp(phone, campaignName, variables = [], name = "") {
  if (!phone) return Promise.resolve();
  return axios({
    method: "post",
    url: process.env.AISENSY_API_URL,
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({
      apiKey: process.env.AISENSY_API_KEY_V2,
      campaignName,
      destination: phone,
      userName: name,
      templateParams: variables,
    }),
  });
}

// Mailjet's ceiling for one message — headers, body and every attachment once
// base64-encoded — is 15 MB. Anything past it is rejected at the API, so a
// caller attaching a file must check BEFORE sending rather than discover it
// as a transport error with a document already promised in the body.
const MAILJET_MESSAGE_LIMIT_BYTES = 15 * 1024 * 1024;

/**
 * The v3.1 message for one template send. Pure — exists so the payload every
 * existing caller produces can be asserted byte-for-byte after the two
 * additions below, rather than assumed unchanged.
 *
 * `opts.from`        — {Email, Name}: per-send sender, for mail that must
 *                      arrive AS the venue rather than as Wedsy. Omitted =
 *                      the account default, exactly as before.
 * `opts.attachments` — [{filename, contentType, base64}]: mapped onto
 *                      Mailjet's Attachments[]. Omitted = no key, as before.
 */
function buildEmailMessage(email, templateId, variables = {}, name = "", opts = {}) {
  const from = opts.from || {};
  const message = {
    From: {
      Email: from.Email || process.env.MAILJET_FROM_EMAIL || "notifications@wedsy.in",
      Name: from.Name || process.env.MAILJET_FROM_NAME || "Wedsy",
    },
    To: [{ Email: email, Name: name }],
    TemplateID: templateId,
    TemplateLanguage: true,
    Variables: variables,
  };
  if (Array.isArray(opts.attachments) && opts.attachments.length) {
    message.Attachments = opts.attachments.map((a) => ({
      ContentType: a.contentType || "application/octet-stream",
      Filename: a.filename || "attachment",
      Base64Content: a.base64,
    }));
  }
  return message;
}

function sendEmail(email, templateId, variables = {}, name = "", opts = {}) {
  if (!email) return Promise.resolve();
  const client = new MailjetClient({
    apiKey: process.env.MAILJET_API_KEY,
    apiSecret: process.env.MAILJET_SECRET_KEY,
  });
  return client.post("send", { version: "v3.1" }).request({
    Messages: [buildEmailMessage(email, templateId, variables, name, opts)],
  });
}

// ─── Master send ──────────────────────────────────────────────────────────────
// Fire-and-forget: returns void, logs channel failures to console.error.
// variables : string[] — positional substitutions for SMS (variables_values) and WhatsApp (templateParams)
// emailVariables : object  — named variables for Mailjet template ({{ var:key }})

function send(triggerId, { phone, email, name = "", variables = [], emailVariables = {}, leadId = null }) {
  const config = TRIGGERS[triggerId];
  if (!config) {
    console.error(`[NotificationService] Unknown trigger: "${triggerId}"`);
    return;
  }

  const sends = [];

  if (config.sms && phone) {
    const { templateId, senderId = "WEDSYY" } = config.sms;
    sends.push(sendSMS(phone, templateId, variables, senderId, { leadId }));
  }

  if (config.whatsapp && phone) {
    sends.push(sendWhatsApp(phone, config.whatsapp.campaign, variables, name));
  }

  // Meta WhatsApp Cloud API leg (Graph, not AiSensy): utils/whatsapp.js builds
  // the template payload per Meta's contract (body component only when there
  // are variables). It retries + FailureLogs internally and resolves null on
  // final failure, so it never rejects this Promise.allSettled.
  if (config.metaTemplate && phone) {
    const { sendWhatsApp: sendMetaTemplate } = require("../utils/whatsapp");
    sends.push(sendMetaTemplate(phone, config.metaTemplate.name, variables));
  }

  if (config.email && email) {
    sends.push(sendEmail(email, config.email.templateId, emailVariables, name));
  }

  if (sends.length === 0) return;

  Promise.allSettled(sends).then((results) => {
    // Order mirrors the push order above (sms, whatsapp, metaTemplate, email).
    const channels = ["sms", "whatsapp", "metaTemplate", "email"].filter((c) => config[c]);
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const channel = channels[i];
        const detail = result.reason?.message || String(result.reason);
        console.error(
          `[NotificationService] ${channel} failed for trigger "${triggerId}":`,
          detail
        );

        // WHY THIS EXISTS: until now a rejected leg died on that console.error
        // and nothing else. That is how 28 live triggers went on calling a
        // CANCELLED AiSensy account for weeks without anyone noticing — the
        // sends failed silently, with no row anywhere to count. The metaTemplate
        // leg already self-logs inside utils/whatsapp.js; sms, whatsapp and
        // email did not. Now every failed leg leaves a trace.
        //
        // Fire-safe by design: a logging failure must never break a send, so
        // this is deliberately not awaited and swallows its own errors.
        const SERVICE_BY_CHANNEL = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };
        const service = SERVICE_BY_CHANNEL[channel];
        if (service) {
          NotificationFailureLog.create({
            service,
            template: triggerId,
            phone: phone || null,
            email: email || null,
            error: detail.slice(0, 500),
            attempts: 1,
            createdAt: new Date(),
          }).catch((logErr) => {
            console.error("[NotificationService] failure-log write failed:", logErr?.message);
          });
        }
      }
    });
  });
}

module.exports = { send, sendSMS, sendEmail, buildEmailMessage, TRIGGERS, MAILJET_MESSAGE_LIMIT_BYTES };

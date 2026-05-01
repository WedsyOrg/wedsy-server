const axios = require("axios");
const { Client: MailjetClient } = require("node-mailjet");

// ─── Trigger config ───────────────────────────────────────────────────────────
// Each trigger lists only the channels that should fire for that event.
// sms.senderId defaults to "WEDSYY" when omitted.
// send() fires all channels in parallel; callers do not need to await.
const TRIGGERS = {
  otp_std:                    { sms: { templateId: "1207173659316115296" }, email: { templateId: 6647480 } },
  event_link:                 { sms: { templateId: "1207173659242837764" }, whatsapp: { campaign: "eventtool_link" } },
  user_event_create:          { whatsapp: { campaign: "user_event_create" }, email: { templateId: 6647516 } },
  event_Reciept:              { sms: { templateId: "1207173659265948967" }, whatsapp: { campaign: "et_reciept" }, email: { templateId: 664758 } },
  event_pmnt_rmnd:            { sms: { templateId: "1207173659891299716" }, whatsapp: { campaign: "et_pymnt_rmnd" }, email: { templateId: 6637087 } },
  et_inv:                     { sms: { templateId: "1207173659443647981" }, whatsapp: { campaign: "et_invoice" }, email: { templateId: 6637124 } },
  mua_account_create_success: { email: { templateId: 6615723 } },
  mua_account_verify_success: { whatsapp: { campaign: "mua_account_verify_success" }, email: { templateId: 6663019 } },
  mua_app_install:            { email: { templateId: 6663277 } },
  MUA_BID_REQS:               { sms: { templateId: "1207173659820026720" }, whatsapp: { campaign: "mua_bid_req" }, email: { templateId: 6621748 } },
  mua_bid_accept:             { sms: { templateId: "1207173659511975942" }, whatsapp: { campaign: "mua_bid_accept" }, email: { templateId: 6629142 } },
  MUA_BID_CONFRM:             { sms: { templateId: "1207173659065451863" }, whatsapp: { campaign: "mua_bid_cnfrm" }, email: { templateId: 6622160 } },
  MUA_PKG_REQS:               { sms: { templateId: "1207173659503361099" }, whatsapp: { campaign: "mua_pkg_req" }, email: { templateId: 6622127 } },
  MUA_PKG_CNFRM:              { sms: { templateId: "1207173617209324567" }, whatsapp: { campaign: "mua_pkg_cnfrm" }, email: { templateId: 6631081 } },
  MUA_PRSNL_PKG_REQS:         { sms: { templateId: "1207173659220414084" }, whatsapp: { campaign: "mua_prsnl_pkg_req" }, email: { templateId: 6622131 } },
  MUA_PRSNL_PKG_CONFRM:       { sms: { templateId: "1207173659447914293" }, whatsapp: { campaign: "mua_prsnl_pkg_cnfrm" }, email: { templateId: 6631200 } },
  mua_new_chat:               { whatsapp: { campaign: "mua_new_chat" } },
  mua_rmnd_dminus1:           { whatsapp: { campaign: "mua_rmnd_dminus1" } },
  mua_rmnd_d_day:             { whatsapp: { campaign: "mua_rmnd_d_day" } },
  mua_settlement:             { whatsapp: { campaign: "mua_settlement" }, email: { templateId: 6712689 } },
  Community_new_topic:        { whatsapp: { campaign: "Community_new_topic" }, email: { templateId: 6663336 } },
  Community_new_reply:        { email: { templateId: 6663362 } },
  mua_bday:                   { whatsapp: { campaign: "mua_bday" }, email: { templateId: 6713649 } },
  mua_task_reminder:          { whatsapp: { campaign: "mua_task_reminder" } },
  cust_bidreqs_send:          { sms: { templateId: "1207173659763736947" }, whatsapp: { campaign: "cust_bidreq_send" }, email: { templateId: 6636091 } },
  cust_bid_recieve:           { sms: { templateId: "1207173659863788355" }, whatsapp: { campaign: "cx_bid_recieve" }, email: { templateId: 6636371 } },
  cx_custoffer_bid:           { sms: { templateId: "1207173659488725685" }, whatsapp: { campaign: "cx_custoffer_bid" }, email: { templateId: 6636185 } },
  cx_bid_cnfrm:               { sms: { templateId: "1207173659150280786" }, whatsapp: { campaign: "cx_bid_cnfrm" }, email: { templateId: 6636379 } },
  cx_prslpkg_req_send:        { whatsapp: { campaign: "cx_prslpkg_req_send" }, email: { templateId: 6631683 } },
  cust_prslpkg_accpt:         { sms: { templateId: "1207173659792451210" }, whatsapp: { campaign: "cust_prslpkg_accept" }, email: { templateId: 6636038 } },
  cust_prslpkg_dcln:          { sms: { templateId: "1207173659777898817" }, whatsapp: { campaign: "cust_prslpkg_reject" }, email: { templateId: 6647374 } },
  cx_pkg_cnfrm:               { sms: { templateId: "1207173659288188115" }, whatsapp: { campaign: "cx_pkg_cnfrm" }, email: { templateId: 6636798 } },
  cust_wedsy_pkg_refund:      { whatsapp: { campaign: "cust_wedsy_pkg_refund" }, email: { templateId: 6649243 } },
  cx_prsnl_pkg_cnfrm:         { sms: { templateId: "1207173659831245860" }, whatsapp: { campaign: "cx_prsnl_pkg_cnfrm" }, email: { templateId: 6636905 } },
  cust_artist_detail:         { sms: { templateId: "1207173659132568015" }, whatsapp: { campaign: "cx_artist_detail" }, email: { templateId: 6636835 } },
  cx_mua_review:              { whatsapp: { campaign: "cx_mua_review" }, email: { templateId: 6637036 } },
  mua_review_app:             { whatsapp: { campaign: "mua_review_app" } },
  cx_pkg_review:              { whatsapp: { campaign: "cx_pkg_review" } },
  mua_cx_pmnt_rmnd_prsnl:     { whatsapp: { campaign: "mua_cx_pmnt_rmnd_prsnl" } },
  user_signup_greet:          { whatsapp: { campaign: "user_signup_greet_wedsy" }, email: { templateId: 6637167 } },
  cust_booking_rmnd:          { sms: { templateId: "1207173675815485814" }, whatsapp: { campaign: "cust_booking_rmnd" }, email: { templateId: 6637515 } },

  // Legacy — old DLT template IDs / AiSensy campaigns used by utils/update.js before template migration
  new_lead:      { sms: { templateId: "163269", senderId: "XWEDSY" }, whatsapp: { campaign: "user_lead" } },
  event_approved:{ whatsapp: { campaign: "eventapproval_confim" } },
};

// ─── Channel senders ──────────────────────────────────────────────────────────

function sendSMS(phone, templateId, variables = [], senderId = "WEDSYY") {
  if (!phone || !phone.includes("+91")) return Promise.resolve();
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
      numbers: phone.replace("+91", ""),
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
      apiKey: process.env.AISENSY_API_KEY,
      campaignName,
      destination: phone,
      userName: name,
      templateParams: variables,
    }),
  });
}

function sendEmail(email, templateId, variables = {}, name = "") {
  if (!email) return Promise.resolve();
  const client = new MailjetClient({
    apiKey: process.env.MAILJET_API_KEY,
    apiSecret: process.env.MAILJET_SECRET_KEY,
  });
  return client.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: {
          Email: process.env.MAILJET_FROM_EMAIL || "notifications@wedsy.in",
          Name: process.env.MAILJET_FROM_NAME || "Wedsy",
        },
        To: [{ Email: email, Name: name }],
        TemplateID: templateId,
        TemplateLanguage: true,
        Variables: variables,
      },
    ],
  });
}

// ─── Master send ──────────────────────────────────────────────────────────────
// Fire-and-forget: returns void, logs channel failures to console.error.
// variables : string[] — positional substitutions for SMS (variables_values) and WhatsApp (templateParams)
// emailVariables : object  — named variables for Mailjet template ({{ var:key }})

function send(triggerId, { phone, email, name = "", variables = [], emailVariables = {} }) {
  const config = TRIGGERS[triggerId];
  if (!config) {
    console.error(`[NotificationService] Unknown trigger: "${triggerId}"`);
    return;
  }

  const sends = [];

  if (config.sms && phone) {
    const { templateId, senderId = "WEDSYY" } = config.sms;
    sends.push(sendSMS(phone, templateId, variables, senderId));
  }

  if (config.whatsapp && phone) {
    sends.push(sendWhatsApp(phone, config.whatsapp.campaign, variables, name));
  }

  if (config.email && email) {
    sends.push(sendEmail(email, config.email.templateId, emailVariables, name));
  }

  if (sends.length === 0) return;

  Promise.allSettled(sends).then((results) => {
    const channels = ["sms", "whatsapp", "email"].filter((c) => config[c]);
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(
          `[NotificationService] ${channels[i]} failed for trigger "${triggerId}":`,
          result.reason?.message || result.reason
        );
      }
    });
  });
}

module.exports = { send };

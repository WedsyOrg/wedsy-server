// MB7a — onboarding emails behind a seam. Reuses Mailjet (the existing mail
// provider) when configured; otherwise dormant (logs and returns, never throws).
// The agreement is emailed to the client on SUCCESSFUL payment; the invoice
// link rides the same path. Mailjet's template sends don't carry our
// dynamic agreement text/attachment cleanly, so these use a raw v3.1 message.
const FROM_EMAIL = process.env.MAILJET_FROM_EMAIL || "notifications@wedsy.in";
const FROM_NAME = process.env.MAILJET_FROM_NAME || "Wedsy";

const isConfigured = () => !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY);

const sendRaw = async ({ to, name, subject, textPart, htmlPart, attachments }) => {
  if (!to) return { sent: false, reason: "no-recipient" };
  if (!isConfigured()) {
    // Dormant: no provider wired. Log so it's traceable and flag in the report.
    console.warn(`[onboarding-mail] DORMANT (Mailjet unset) — would email "${subject}" to ${to}`);
    return { sent: false, reason: "dormant" };
  }
  try {
    const { Client: MailjetClient } = require("node-mailjet");
    const client = new MailjetClient({ apiKey: process.env.MAILJET_API_KEY, apiSecret: process.env.MAILJET_SECRET_KEY });
    await client.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: { Email: FROM_EMAIL, Name: FROM_NAME },
          To: [{ Email: to, Name: name || "" }],
          Subject: subject,
          TextPart: textPart || "",
          ...(htmlPart ? { HTMLPart: htmlPart } : {}),
          ...(attachments && attachments.length ? { Attachments: attachments } : {}),
        },
      ],
    });
    return { sent: true };
  } catch (e) {
    console.error("[onboarding-mail] send failed:", e.message);
    return { sent: false, reason: "error", error: e.message };
  }
};

// Email the accepted agreement on successful payment. Fire-safe.
const sendAgreementEmail = async ({ to, name, termsText, version, invoiceUrl }) => {
  const body =
    `Hi ${name || "there"},\n\nThank you — your payment is confirmed.\n\n` +
    `Here is the Wedsy service agreement (version ${version || "v1"}) you accepted:\n\n` +
    `${termsText || ""}\n\n` +
    (invoiceUrl ? `Your invoice: ${invoiceUrl}\n\n` : "") +
    `Warmly,\nTeam Wedsy`;
  return sendRaw({ to, name, subject: "Your Wedsy agreement & payment confirmation", textPart: body });
};

module.exports = { isConfigured, sendRaw, sendAgreementEmail };

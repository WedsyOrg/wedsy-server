/**
 * services/VenueTermsMail.js — the ONE place a venue's terms & conditions
 * are emailed from, and the one place the delivery verdict is written.
 *
 * Two controllers send terms: venueTerms.sendTerms (generated clauses, or the
 * raw uploaded PDF) and venueLeadDocument.generateTermsDocument (the stitched,
 * versioned document). Both used to fire NotificationService.send() and set
 * `delivered = true` the moment the CALL was made — before Mailjet had
 * answered, before it could have refused. While no template existed that line
 * never ran, so nothing lied. With a template behind it, it would have written
 * a false delivery onto the dispute record on every transport failure.
 *
 * So this module:
 *   - AWAITS the send and sets `delivered` from what Mailjet actually returned
 *   - refuses BEFORE sending when the attachment cannot fit Mailjet's message
 *     limit, naming the size — never a stripped email, never a silent link
 *   - always attaches the PDF: uploaded or generated, it IS the terms, and an
 *     email saying "attached" with nothing attached is worse than an honest
 *     failure
 *   - sends AS THE VENUE: partner_venue@wedsy.in with the venue's name on it,
 *     which is why NotificationService.sendEmail grew a per-send `from`
 *   - writes the verdict onto the quote round with one helper, so the two
 *     callers cannot record it differently
 *
 * Every refusal reads the way the missing-template case always did — a
 * specific reason the client already renders verbatim.
 */
const VenueOwner = require("../models/VenueOwner");
const NotificationService = require("./NotificationService");

const TEMPLATE_ENV = "MAILJET_TEMPLATE_VENUE_TERMS";
const TRIGGER = "venue_terms_sent";
// The verified sender for venue-voiced mail. An env override, like every other
// Mailjet sender in this codebase; the fallback is the address that is Active
// in the account for exactly this purpose.
const DEFAULT_VENUE_SENDER = "partner_venue@wedsy.in";
// Headroom for the rendered template body inside the 15 MB ceiling. The HTML
// is ~12 KB; 256 KB leaves room for it, the text part and the envelope with
// margin to spare, and errs towards refusing a file that would be rejected.
const BODY_ALLOWANCE_BYTES = 256 * 1024;

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * The name that signs the email: the venue's owner. A VenueOwner with the
 * owner role, else the contact name the venue gave, else the venue itself —
 * never blank, and never "Wedsy".
 */
async function resolveOwnerName(venue) {
  const owner = await VenueOwner.findOne({ venueId: venue._id, role: "owner", isActive: { $ne: false } })
    .sort({ createdAt: 1 })
    .select("name")
    .lean();
  if (owner && owner.name) return owner.name;
  const contact = venue.contact || {};
  return contact.primaryName || venue.name || "";
}

function resolvePhone(venue) {
  const contact = venue.contact || {};
  return contact.primaryPhone || venue.phone || "";
}

/**
 * The logo only when a mail client can fetch it. A data: URI is what the
 * uploader stores for some venues and is blocked by most inboxes; the template
 * falls back to the venue's name in text when this is empty.
 */
function resolveLogoUrl(venue) {
  const logo = venue.logo;
  return typeof logo === "string" && /^https?:\/\//.test(logo) ? logo : "";
}

/**
 * Is this attachment sendable at all? Answered from the base64 size the wire
 * will carry, not the file's size on disk — base64 is 4/3 the bytes, and the
 * limit is on the message as Mailjet receives it.
 */
function attachmentVerdict(buffer, filename, limit = NotificationService.MAILJET_MESSAGE_LIMIT_BYTES) {
  const raw = buffer ? buffer.length : 0;
  const encoded = Math.ceil(raw / 3) * 4;
  const total = encoded + BODY_ALLOWANCE_BYTES;
  if (total <= limit) return { ok: true, raw, encoded };
  return {
    ok: false,
    raw,
    encoded,
    reason:
      `The terms PDF ${filename ? `(${filename}) ` : ""}is ${mb(raw)} — ${mb(encoded)} once encoded for email — ` +
      `which is over Mailjet's ${mb(limit)} message limit. The send was recorded but not emailed. ` +
      `Upload a smaller PDF in Settings to email it.`,
  };
}

/** What Mailjet said, as a verdict. Pure, so a test can hand it any shape. */
function verdictFromResponse(response) {
  const body = response && response.body;
  const msg = body && Array.isArray(body.Messages) ? body.Messages[0] : null;
  if (!msg) return { delivered: false, deliveryError: "Mailjet returned no message status." };
  if (msg.Status === "success") {
    const to = Array.isArray(msg.To) && msg.To[0];
    return { delivered: true, deliveryError: "", messageId: to && to.MessageID ? String(to.MessageID) : "" };
  }
  const err = Array.isArray(msg.Errors) && msg.Errors[0];
  const detail = err ? `${err.ErrorMessage || err.ErrorIdentifier || "unknown error"}${err.ErrorRelatedTo ? ` (${[].concat(err.ErrorRelatedTo).join(", ")})` : ""}` : "no detail";
  return { delivered: false, deliveryError: `Mailjet refused the email: ${detail}` };
}

/** The transport error, in the words the owner will read. */
function verdictFromThrown(e) {
  const body = e && e.response && e.response.body;
  const detail =
    (body && (body.ErrorMessage || (Array.isArray(body.Messages) && body.Messages[0] && body.Messages[0].Errors && body.Messages[0].Errors[0] && body.Messages[0].Errors[0].ErrorMessage))) ||
    (e && e.message) ||
    "unknown error";
  const status = e && e.statusCode ? ` (HTTP ${e.statusCode})` : "";
  return { delivered: false, deliveryError: `Email transport failed${status}: ${String(detail).trim().replace(/\.+$/, "")}. The send was recorded but not emailed.` };
}

/**
 * Send the terms email. Never throws — the caller already holds the record,
 * and a transport problem must become a verdict on it, not a 500 that loses
 * the fact that the owner sent.
 *
 * @param {object} p
 * @param {object} p.venue       lean Venue with name, logo, contact, phone
 * @param {object} p.lead        the enquiry (coupleName / name)
 * @param {string} p.email       recipient
 * @param {{filename: string, buffer: Buffer}|function} p.attachment
 *        the PDF bytes, or an async function that produces them. The function
 *        form is for the caller that has to FETCH or RENDER the PDF: it runs
 *        only after the configuration checks pass, so a venue on a box with no
 *        template does not pull a 10 MB file from storage to then not send it,
 *        and a fetch failure becomes a verdict on the record, not a throw.
 * @param {object} [p.transport] sendEmail override — tests only
 * @returns {Promise<{delivered: boolean, deliveryError: string, messageId?: string}>}
 */
async function sendVenueTermsEmail({ venue, lead, email, attachment, transport } = {}) {
  const templateId = Number(process.env[TEMPLATE_ENV]);
  if (!templateId) {
    return {
      delivered: false,
      deliveryError: `No "${TRIGGER}" email template is configured (${TEMPLATE_ENV}) — the send was recorded but not emailed.`,
    };
  }
  if (!process.env.MAILJET_API_KEY || !process.env.MAILJET_SECRET_KEY) {
    return { delivered: false, deliveryError: "Email transport is not configured on this environment — the send was recorded but not emailed." };
  }
  if (typeof attachment === "function") {
    try {
      attachment = await attachment();
    } catch (e) {
      console.warn(`[VenueTermsMail] could not prepare the terms PDF for lead ${lead && lead._id}: ${e.message}`);
      return { delivered: false, deliveryError: `The terms PDF could not be prepared (${e.message}), so nothing was emailed. The send was recorded.` };
    }
  }
  if (!attachment || !attachment.buffer || !attachment.buffer.length) {
    // The body says "attached". Sending it with nothing attached is the one
    // thing this module exists to never do.
    return { delivered: false, deliveryError: "The terms PDF could not be prepared, so nothing was emailed. The send was recorded." };
  }
  const size = attachmentVerdict(attachment.buffer, attachment.filename);
  if (!size.ok) return { delivered: false, deliveryError: size.reason };

  const coupleName = (lead && (lead.coupleName || lead.name)) || "";
  const variables = {
    venue_name: venue.name || "",
    couple_name: coupleName,
    owner_name: await resolveOwnerName(venue),
    venue_phone: resolvePhone(venue),
    venue_logo: resolveLogoUrl(venue),
  };
  const from = {
    Email: process.env.MAILJET_VENUE_FROM_EMAIL || DEFAULT_VENUE_SENDER,
    Name: venue.name || "",
  };
  const sendEmail = transport || NotificationService.sendEmail;
  try {
    const response = await sendEmail(email, templateId, variables, coupleName, {
      from,
      attachments: [{ filename: attachment.filename || "terms.pdf", contentType: "application/pdf", base64: attachment.buffer.toString("base64") }],
    });
    return verdictFromResponse(response);
  } catch (e) {
    console.warn(`[VenueTermsMail] send failed for lead ${lead && lead._id}: ${e.message}`);
    return verdictFromThrown(e);
  }
}

/** Write the verdict onto the round. One writer, so both callers agree. */
function recordDelivery(round, verdict) {
  round.termsDelivered = Boolean(verdict.delivered);
  round.termsDeliveryError = verdict.delivered ? "" : verdict.deliveryError || "";
  round.termsDeliveredAt = verdict.delivered ? new Date() : null;
  round.termsMessageId = verdict.delivered ? verdict.messageId || "" : "";
}

module.exports = {
  sendVenueTermsEmail,
  recordDelivery,
  attachmentVerdict,
  verdictFromResponse,
  verdictFromThrown,
  resolveOwnerName,
  TEMPLATE_ENV,
  TRIGGER,
  BODY_ALLOWANCE_BYTES,
};

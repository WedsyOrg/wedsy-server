/**
 * services/VenueTermsMail.js — THIN CALLER over services/VenueMail for the
 * terms & conditions send.
 *
 * Everything this module used to own — the venue From, the size guard, the
 * verdict from Mailjet's answer, the attachment rule — now lives in VenueMail,
 * which is the one way a venue emails a couple. What remains here is the
 * terms-specific part: the round-level verdict fields (`termsDelivered` etc.)
 * that the quote thread's pill reads, written by `recordDelivery`.
 *
 * Kept as a module rather than deleted so the two terms controllers and their
 * suites keep one import; the shared names are re-exports, so nothing that
 * imported them changes.
 */
const VenueMail = require("./VenueMail");

const TEMPLATE_ENV = VenueMail.KINDS.terms.env;
const TRIGGER = VenueMail.KINDS.terms.slug;

/**
 * Send the terms email through VenueMail. Same options as before plus:
 * @param p.document  the VenueLeadDocument row when there is one (stitched path)
 * @param p.message   the owner's message; default copy when empty
 * @param p.actor     {id, name} — who pressed send, for the record
 * @returns the verdict, plus `send` (the VenueEmailSend row)
 */
async function sendVenueTermsEmail({ venue, lead, email, name, attachment, document, message, actor, transport, allowMailjet } = {}) {
  const { send, verdict } = await VenueMail.sendDocumentEmail({
    venue, lead, kind: "terms", document, email, name, message, attachment, actor, transport, allowMailjet,
  });
  return { ...verdict, send };
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
  attachmentVerdict: VenueMail.attachmentVerdict,
  verdictFromResponse: VenueMail.verdictFromResponse,
  verdictFromThrown: VenueMail.verdictFromThrown,
  resolveOwnerName: VenueMail.resolveOwnerName,
  TEMPLATE_ENV,
  TRIGGER,
  BODY_ALLOWANCE_BYTES: VenueMail.BODY_ALLOWANCE_BYTES,
};

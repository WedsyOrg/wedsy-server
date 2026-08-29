/**
 * controllers/venueDocumentSend.js — SEND TO CLIENT, on every venue document.
 *
 * One control, one modal, every kind. The owner picks who (the decision maker
 * is preselected — see utils/venueRecipients), edits the one editable region
 * (the message), sees the email as it will go, and sends. The PDF is the
 * stored VenueLeadDocument, fetched from storage at send time; the email and
 * its verdict are one VenueEmailSend row per send — the receipt the "Emails
 * sent" panel opens.
 *
 * Quote is the one kind that had no stored artefact (streamed to the
 * response and gone), so `storeQuoteDocument` renders it to bytes and files
 * it as a VenueLeadDocument like the others before it can be sent.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueEmailSend = require("../models/VenueEmailSend");
const VenueQuote = require("../models/VenueQuote");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
// Referenced through their modules (not destructured) so a suite can stand
// in for storage without a network: the send path is what is under test.
const pdfStitch = require("../utils/pdfStitch");
const s3 = require("../utils/s3Upload");
const { buildQuotePdfBuffer } = require("../utils/venuePdf");
const { sanitizeContacts } = require("../utils/venueContacts");
const { recipientOptions, isOnLead, EMAIL_RE } = require("../utils/venueRecipients");
const VenueMail = require("../services/VenueMail");
const { insertNextVersion } = require("./venueLeadDocument");

const MAX_MESSAGE = 4000;
const SENDABLE_KINDS = Object.keys(VenueMail.KINDS);

async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    .select("_id name slug logo address formattedAddress contact phone email settings termsDocument whiteLabel")
    .lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) { res.status(404).json({ message: "Lead not found" }); return null; }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) { res.status(404).json({ message: "Lead not found" }); return null; }
  return { venue, lead };
}

async function resolveDocument(req, res, lead) {
  if (!mongoose.isValidObjectId(req.params.documentId)) { res.status(404).json({ message: "Document not found" }); return null; }
  const doc = await VenueLeadDocument.findOne({ _id: req.params.documentId, enquiry: lead._id }).lean();
  if (!doc) { res.status(404).json({ message: "Document not found" }); return null; }
  if (!SENDABLE_KINDS.includes(doc.kind)) {
    res.status(400).json({ message: "Only documents the venue generated can be sent to the client.", code: "not_sendable" });
    return null;
  }
  if (!doc.url) { res.status(400).json({ message: "This document has no stored file to attach.", code: "no_stored_file" }); return null; }
  return doc;
}

const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;
async function actorOf(req) {
  const o = req.venueOwner || {};
  let name = o.name || "Owner";
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    name = (m && m.name) || "team member";
  }
  return { id: actorId(req), name };
}

const presentSend = (s, { withBody = false } = {}) => ({
  _id: s._id,
  documentId: s.document || null,
  documentKind: s.documentKind,
  documentLabel: (VenueMail.KINDS[s.documentKind] || {}).label || s.documentKind,
  documentVersion: s.documentVersion || null,
  subject: s.subject,
  to: s.to,
  from: s.from,
  message: s.message,
  attachment: { filename: (s.attachment && s.attachment.filename) || "", sizeBytes: (s.attachment && s.attachment.sizeBytes) || null, hasFile: Boolean(s.attachment && s.attachment.url) },
  delivered: Boolean(s.delivered),
  deliveryError: s.deliveryError || "",
  messageId: s.messageId || "",
  sentAt: s.sentAt,
  deliveredAt: s.deliveredAt || null,
  triggeredByName: s.triggeredByName || "",
  renderedFrom: s.renderedFrom || "",
  ...(withBody ? { renderedHtml: s.renderedHtml, renderedText: s.renderedText } : {}),
});

// ── GET /venues/:slug/enquiries/:enquiryId/documents/:documentId/send-preview ─
// What the modal needs: who to send to (preselection made), the default
// message, and the email rendered as it will go with the message applied
// (?message= overrides, for live preview). Also whether the live template
// actually carries the message region — a template edited in Mailjet without
// {{var:message_html}} would silently drop the owner's words, so the screen
// locks the region and says so rather than pretending.
const sendPreview = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const doc = await resolveDocument(req, res, lead);
    if (!doc) return;
    const message = req.query.message !== undefined ? cleanStr(req.query.message).slice(0, MAX_MESSAGE) : VenueMail.defaultMessage(doc.kind, { venue, document: doc });
    // Who it is addressed to, so the greeting is theirs: a contact's email
    // resolves to their name; a typed name is used as given; nobody → couple.
    const toEmail = cleanStr(req.query.to).toLowerCase();
    const toContact = toEmail ? (lead.contacts || []).find((c) => String(c.email || "").toLowerCase() === toEmail) : null;
    const recipientName = (toContact && toContact.name) || cleanStr(req.query.toName).slice(0, 200) || "";
    const rendered = await VenueMail.renderPreview({ venue, lead, kind: doc.kind, message, document: doc, recipientName });
    const src = await VenueMail.templateSource(doc.kind, rendered.templateId);
    const options = recipientOptions(lead);
    return res.status(200).json({
      document: { _id: doc._id, kind: doc.kind, label: VenueMail.KINDS[doc.kind].label, version: doc.version, filename: doc.filename, sizeBytes: doc.sizeBytes || null },
      ...options,
      defaultMessage: VenueMail.defaultMessage(doc.kind, { venue, document: doc }),
      message,
      subject: rendered.subject,
      from: { email: rendered.from.Email, name: rendered.from.Name },
      html: rendered.html,
      renderedFrom: rendered.renderedFrom,
      // Said on screen, not thrown: a send made now would record this reason.
      renderError: rendered.renderError || "",
      messageSupported: Boolean(src) && /\{\{\s*var:message_html\s*\}\}/.test(src.html),
      configured: Boolean(rendered.templateId),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/documents/:documentId/send ─────
// { email, name?, message?, addContact?: { name? } }
const sendDocument = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const doc = await resolveDocument(req, res, lead);
    if (!doc) return;
    const body = req.body || {};
    const email = cleanStr(body.email).toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ message: "A valid email address is required" });
    const message = cleanStr(body.message).slice(0, MAX_MESSAGE);
    let name = cleanStr(body.name).slice(0, 200);

    // A typed address the lead does not have yet: add it as a contact when the
    // owner asked, so it is there next time rather than retyped.
    let contactAdded = false;
    if (body.addContact && !isOnLead(lead, email)) {
      const next = [...(lead.contacts || []).map((c) => (typeof c.toObject === "function" ? c.toObject() : c)), { name: cleanStr(body.addContact.name || name).slice(0, 200), email, relation: "other" }];
      const v = sanitizeContacts(next, lead.eventType);
      if (!v.ok) return res.status(400).json({ message: v.message });
      lead.contacts = v.value;
      contactAdded = true;
    }
    if (!name) {
      const hit = (lead.contacts || []).find((c) => String(c.email || "").toLowerCase() === email);
      name = (hit && hit.name) || "";
    }

    const actor = await actorOf(req);
    const { send, verdict } = await VenueMail.sendDocumentEmail({
      venue,
      lead,
      kind: doc.kind,
      document: doc,
      email,
      name,
      message,
      actor,
      // Lazy: fetched from storage only once the transport is known to be
      // configured; a storage failure becomes a verdict on the record.
      attachment: async () => ({ filename: doc.filename || `${doc.kind}.pdf`, buffer: await pdfStitch.fetchSourcePdf(doc.url), url: doc.url }),
    });
    await lead.save();

    return res.status(201).json({ success: true, send: presentSend(send), delivered: verdict.delivered, deliveryError: verdict.deliveryError, contactAdded });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── GET /venues/:slug/enquiries/:enquiryId/emails ───────────────────────────
const listEmails = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const rows = await VenueEmailSend.find({ enquiry: owned.lead._id }).sort({ sentAt: -1, _id: -1 }).select("-renderedHtml -renderedText -variables").lean();
    return res.status(200).json({ emails: rows.map((s) => presentSend(s)), total: rows.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── GET /venues/:slug/enquiries/:enquiryId/emails/:sendId ──────────────────
const getEmail = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    if (!mongoose.isValidObjectId(req.params.sendId)) return res.status(404).json({ message: "Email not found" });
    const s = await VenueEmailSend.findOne({ _id: req.params.sendId, enquiry: owned.lead._id }).lean();
    if (!s) return res.status(404).json({ message: "Email not found" });
    return res.status(200).json({ email: presentSend(s, { withBody: true }) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/documents/quote { quoteId?, note? }
// File the quote as a document so it can be sent like the others. The named
// quote, else the latest for this lead. Linked to the quote round that points
// at it (VenueQuoteRound.quoteRef), so `quoteRound` is a promise the data
// keeps rather than a null.
const storeQuoteDocument = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};
    let quote;
    if (body.quoteId) {
      if (!mongoose.isValidObjectId(body.quoteId)) return res.status(400).json({ message: "quoteId is not valid" });
      quote = await VenueQuote.findOne({ _id: body.quoteId, venue: venue._id, enquiry: lead._id }).lean();
      if (!quote) return res.status(404).json({ message: "Quote not found" });
    } else {
      quote = await VenueQuote.findOne({ venue: venue._id, enquiry: lead._id }).sort({ version: -1 }).lean();
      if (!quote) return res.status(400).json({ message: "This lead has no quote yet. Create one on the Money tab first.", code: "no_quote" });
    }
    const buffer = await buildQuotePdfBuffer({ venue, enquiry: lead, quote });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `venues/${venue._id}/quotes/${stamp}.pdf`;
    let url;
    try {
      url = await s3.uploadBufferToS3({ buffer, key, contentType: "application/pdf" });
    } catch (e) {
      console.error(`[venueDocumentSend] S3 upload failed for quote ${quote._id}: ${e.message}`);
      return res.status(502).json({ message: "The quote PDF was generated but could not be stored. Nothing was sent — try again.", code: "storage_failed" });
    }
    const round = await VenueQuoteRound.findOne({ enquiry: lead._id, quoteRef: quote._id }).sort({ createdAt: -1 }).select("_id").lean();
    const actor = await actorOf(req);
    const safeCouple = (lead.coupleName || "quote").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "quote";
    const doc = await insertNextVersion(
      {
        venue: venue._id,
        enquiry: lead._id,
        kind: "quote",
        note: cleanStr(body.note).slice(0, 2000) || `Quote v${quote.version || 1}`,
        url,
        sizeBytes: buffer.length,
        contentType: "application/pdf",
        cover: { coupleName: lead.coupleName || "", quotedAmount: (quote.totals && quote.totals.grandTotal) || null },
        generatedBy: actor.id,
        generatedByName: actor.name,
        quoteRound: round ? round._id : undefined,
      },
      (version) => ({ filename: `quote-${safeCouple}-v${version}.pdf` })
    );
    lead.activities.push({
      type: "document_generated",
      description: `Quote v${quote.version || 1} filed as document v${doc.version}`,
      actor: actor.id,
      timestamp: new Date(),
      ref: doc._id,
      refModel: "VenueLeadDocument",
    });
    await lead.save();
    return res.status(201).json({ success: true, documentId: doc._id, version: doc.version, filename: doc.filename, quoteVersion: quote.version || 1 });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── GET /venues/:slug/enquiries/:enquiryId/documents/quote/options ─────────
const quoteOptions = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const quotes = await VenueQuote.find({ venue: owned.venue._id, enquiry: owned.lead._id }).sort({ version: -1 }).select("version status totals.grandTotal updatedAt").lean();
    return res.status(200).json({ quotes: quotes.map((q) => ({ _id: q._id, version: q.version, status: q.status, grandTotal: (q.totals && q.totals.grandTotal) || 0, updatedAt: q.updatedAt })) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { sendPreview, sendDocument, listEmails, getEmail, storeQuoteDocument, quoteOptions, presentSend };

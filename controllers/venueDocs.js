/**
 * controllers/venueDocs.js — D8 document engine: owner document templates,
 * bill-before-invoice lifecycle, and the white-label acceptance flow.
 *
 * Extends — never discards — the live quote/invoice/GST/PDF engine:
 * conversion allocates a real invoice through venueInvoice.allocateInvoice
 * (the one numbering path), money math stays in utils/venueMoney, and the
 * public acceptance token reuses the contract-ack pattern (typed JWT,
 * rate-limited at the route).
 */
const jwt = require("jsonwebtoken");
const Venue = require("../models/Venue");
const VenueBill = require("../models/VenueBill");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");
const VenueCounter = require("../models/VenueCounter");
const VenueDocumentTemplate = require("../models/VenueDocumentTemplate");
const { computeTotals, GST_MODES } = require("../utils/venueMoney");
const { allocateInvoice } = require("./venueInvoice");
const { streamBillPdf } = require("../utils/venuePdf");
const { reqStr, optStr } = require("../utils/venueInput");

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

async function resolveOwnedVenue(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

function validTerms(terms) {
  if (terms === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(terms) || terms.length > 50 || terms.some((t) => typeof t !== "string" || t.length > 2000)) {
    return { ok: false, message: "terms must be an array of strings (max 50 × 2000 chars)" };
  }
  return { ok: true, value: terms.map((t) => t.trim()).filter(Boolean) };
}

function validLineItems(lineItems) {
  if (lineItems === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(lineItems) || lineItems.length > 200) return { ok: false, message: "lineItems must be an array (max 200)" };
  for (const li of lineItems) {
    if (typeof (li && li.label) !== "string" || li.label.length > 500) return { ok: false, message: "each line item needs a label (max 500 chars)" };
    const qty = Number(li.qty), unit = Number(li.unitPrice);
    if (!Number.isFinite(qty) || qty < 0 || qty > 1e6) return { ok: false, message: "line item qty out of range" };
    if (!Number.isFinite(unit) || unit < 0 || unit > 1e9) return { ok: false, message: "line item unitPrice out of range" };
  }
  return { ok: true, value: lineItems };
}

// Effective T&C for a doc: explicit terms > template terms > policyDoc lines.
function termsFromPolicyDoc(venue) {
  const pd = venue.policyDoc || {};
  return [...(pd.policies || []), ...(pd.terms || []), ...(pd.refund || [])].slice(0, 50);
}

// ── Templates (documents capability) ──

const listTemplates = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    if (req.query.type) filter.type = req.query.type;
    const templates = await VenueDocumentTemplate.find(filter).sort({ type: 1, name: 1 }).lean();
    return res.status(200).json({ templates, total: templates.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const TEMPLATE_TYPES = ["quote", "bill", "invoice", "contract", "custom"];

const createTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    if (!TEMPLATE_TYPES.includes(body.type)) return res.status(400).json({ message: `type must be one of ${TEMPLATE_TYPES.join(", ")}` });
    const nameV = reqStr(body.name, "name", 200);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const termsV = validTerms(body.terms);
    if (!termsV.ok) return res.status(400).json({ message: termsV.message });
    const itemsV = validLineItems(body.lineItems);
    if (!itemsV.ok) return res.status(400).json({ message: itemsV.message });
    if (body.gstMode !== undefined && !GST_MODES.includes(body.gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    const pct = body.gstPercent !== undefined ? Number(body.gstPercent) : 18;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });

    const template = await VenueDocumentTemplate.create({
      venue: venue._id,
      type: body.type,
      name: nameV.value,
      lineItems: itemsV.value || [],
      sections: Array.isArray(body.sections) ? body.sections.slice(0, 30) : [],
      terms: termsV.value || [],
      gstMode: body.gstMode || "exclusive",
      gstPercent: pct,
    });
    return res.status(201).json({ template });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A template with this type + name already exists" });
    return res.status(500).json({ message: err.message });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const template = await VenueDocumentTemplate.findOne({ _id: req.params.templateId, venue: venue._id });
    if (!template) return res.status(404).json({ message: "Template not found" });
    const body = req.body || {};
    if (body.name !== undefined) {
      const nameV = reqStr(body.name, "name", 200);
      if (!nameV.ok) return res.status(400).json({ message: nameV.message });
      template.name = nameV.value;
    }
    if (body.terms !== undefined) {
      const termsV = validTerms(body.terms);
      if (!termsV.ok) return res.status(400).json({ message: termsV.message });
      template.terms = termsV.value;
    }
    if (body.lineItems !== undefined) {
      const itemsV = validLineItems(body.lineItems);
      if (!itemsV.ok) return res.status(400).json({ message: itemsV.message });
      template.lineItems = itemsV.value;
    }
    if (body.sections !== undefined) template.sections = Array.isArray(body.sections) ? body.sections.slice(0, 30) : [];
    if (body.gstMode !== undefined) {
      if (!GST_MODES.includes(body.gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
      template.gstMode = body.gstMode;
    }
    if (body.gstPercent !== undefined) {
      const pct = Number(body.gstPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
      template.gstPercent = pct;
    }
    await template.save();
    return res.status(200).json({ template });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A template with this type + name already exists" });
    return res.status(500).json({ message: err.message });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const del = await VenueDocumentTemplate.deleteOne({ _id: req.params.templateId, venue: venue._id });
    if (del.deletedCount === 0) return res.status(404).json({ message: "Template not found" });
    return res.status(200).json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── Bills (documents capability) ──

// POST /venues/:slug/bills — create a working bill for a booking. Optional
// templateId seeds line items / GST / terms; isAddon marks post-booking
// supplementary bills. Terms fall back template → policyDoc.
const createBill = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id policyDoc");
    if (!venue) return;
    const body = req.body || {};
    if (!body.booking) return res.status(400).json({ message: "booking is required" });
    const booking = await VenueBooking.findOne({ _id: body.booking, venue: venue._id }).select("_id totalValue").lean();
    if (!booking) return res.status(404).json({ message: "Booking not found for this venue" });

    let template = null;
    if (body.templateId) {
      template = await VenueDocumentTemplate.findOne({ _id: body.templateId, venue: venue._id }).lean();
      if (!template) return res.status(400).json({ message: "Unknown templateId for this venue" });
    }

    const itemsV = validLineItems(body.lineItems);
    if (!itemsV.ok) return res.status(400).json({ message: itemsV.message });
    const termsV = validTerms(body.terms);
    if (!termsV.ok) return res.status(400).json({ message: termsV.message });
    if (body.gstMode !== undefined && !GST_MODES.includes(body.gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    const pct = body.gstPercent !== undefined ? Number(body.gstPercent) : template ? template.gstPercent : 18;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
    const disc = Number(body.discount) || 0;
    if (disc < 0) return res.status(400).json({ message: "discount must be >= 0" });

    const items = itemsV.value || (template && template.lineItems.length ? template.lineItems : [{ label: "Venue booking", category: "venue_hire", qty: 1, unitPrice: booking.totalValue || 0 }]);
    const mode = body.gstMode || (template && template.gstMode) || "exclusive";
    const terms = termsV.value !== undefined ? termsV.value : template && template.terms.length ? template.terms : termsFromPolicyDoc(venue);

    const seq = await VenueCounter.next(`${venue._id}:bill`);
    const bill = await VenueBill.create({
      venue: venue._id,
      booking: booking._id,
      billNumber: `BILL-${seq}`,
      isAddon: body.isAddon === true,
      lineItems: items,
      gstMode: mode,
      gstPercent: pct,
      discount: disc,
      totals: computeTotals(items, pct, disc, mode),
      terms,
      notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : "",
    });
    return res.status(201).json({ bill });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const listBills = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    if (req.query.booking) filter.booking = req.query.booking;
    if (req.query.status) filter.status = req.query.status;
    const bills = await VenueBill.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ bills, total: bills.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/bills/:billId — edit while draft/sent (money + terms).
const updateBill = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const bill = await VenueBill.findOne({ _id: req.params.billId, venue: venue._id });
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    if (!["draft", "sent"].includes(bill.status)) return res.status(409).json({ message: `A ${bill.status} bill cannot be edited` });
    const body = req.body || {};
    const itemsV = validLineItems(body.lineItems);
    if (!itemsV.ok) return res.status(400).json({ message: itemsV.message });
    const termsV = validTerms(body.terms);
    if (!termsV.ok) return res.status(400).json({ message: termsV.message });
    if (body.gstMode !== undefined && !GST_MODES.includes(body.gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    if (body.gstPercent !== undefined) {
      const pct = Number(body.gstPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
      bill.gstPercent = pct;
    }
    if (body.discount !== undefined) {
      const disc = Number(body.discount);
      if (!Number.isFinite(disc) || disc < 0) return res.status(400).json({ message: "discount must be >= 0" });
      bill.discount = disc;
    }
    if (itemsV.value !== undefined) bill.lineItems = itemsV.value;
    if (termsV.value !== undefined) bill.terms = termsV.value;
    if (body.gstMode !== undefined) bill.gstMode = body.gstMode;
    if (typeof body.notes === "string") bill.notes = body.notes.slice(0, 2000);
    bill.totals = computeTotals(bill.lineItems, bill.gstPercent, bill.discount, bill.gstMode);
    await bill.save();
    return res.status(200).json({ bill });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/bills/:billId/send — mark sent + mint the typed public
// acceptance token (contract-ack pattern; rate-limited public routes below).
const sendBill = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const bill = await VenueBill.findOne({ _id: req.params.billId, venue: venue._id });
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    if (!["draft", "sent"].includes(bill.status)) return res.status(409).json({ message: `A ${bill.status} bill cannot be sent` });
    if (!bill.lineItems.length) return res.status(400).json({ message: "Cannot send a bill with no line items" });
    bill.status = "sent";
    await bill.save();
    const token = jwt.sign({ type: "venue_doc_ack", docType: "bill", docId: String(bill._id) }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return res.status(200).json({ bill, ackToken: token, ackPath: `/doc-ack?token=${token}` });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/bills/:billId/convert — accepted/sent bill → REAL invoice
// through the untouched numbering path. Bill becomes converted + linked.
const convertBill = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id invoicePrefix");
    if (!venue) return;
    const bill = await VenueBill.findOne({ _id: req.params.billId, venue: venue._id });
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    if (!["draft", "sent", "accepted"].includes(bill.status)) {
      return res.status(409).json({ message: `A ${bill.status} bill cannot be converted` });
    }
    const invoice = await allocateInvoice(venue, {
      booking: bill.booking,
      kind: bill.isAddon ? "addon" : req.body && req.body.kind === "final" ? "final" : "advance",
      lineItems: bill.lineItems,
      gstPercent: bill.gstPercent,
      gstMode: bill.gstMode,
      discount: bill.discount,
      totals: bill.totals,
      terms: bill.terms,
      acceptance: bill.acceptance && bill.acceptance.at ? bill.acceptance : undefined,
      billRef: bill._id,
      status: "unpaid",
      payments: [],
    });
    bill.status = "converted";
    bill.invoiceRef = invoice._id;
    await bill.save();
    return res.status(201).json({ bill, invoice });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message });
  }
};

// GET /venues/:slug/bills/:billId/pdf — white-label working bill.
const billPdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "name address formattedAddress contact phone email gstin pan logo");
    if (!venue) return;
    const bill = await VenueBill.findOne({ _id: req.params.billId, venue: venue._id }).lean();
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    const booking = await VenueBooking.findById(bill.booking).select("coupleName couplePhone").lean();
    await streamBillPdf(res, { venue, booking, bill });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── Public acceptance (typed token; publicReadLimiter at the route) ──

function verifyDocToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || payload.type !== "venue_doc_ack" || !payload.docType || !payload.docId) return null;
    return payload;
  } catch { return null; }
}

async function loadAckDoc(payload) {
  if (payload.docType === "bill") {
    const bill = await VenueBill.findById(payload.docId);
    if (!bill) return null;
    const booking = await VenueBooking.findById(bill.booking).select("coupleName couplePhone").lean();
    return { kind: "bill", doc: bill, partyName: booking && booking.coupleName, partyPhone: booking && booking.couplePhone };
  }
  if (payload.docType === "quote") {
    const quote = await VenueQuote.findById(payload.docId);
    if (!quote) return null;
    const VenueEnquiry = require("../models/VenueEnquiry");
    const enq = await VenueEnquiry.findById(quote.enquiry).select("coupleName couplePhone").lean();
    return { kind: "quote", doc: quote, partyName: enq && enq.coupleName, partyPhone: enq && enq.couplePhone };
  }
  return null;
}

// GET /venues/doc-ack/:token — the white-label acceptance page payload: venue
// identity + money + terms. Never exposes other venue data.
const getAckDoc = async (req, res) => {
  try {
    const payload = verifyDocToken(req.params.token);
    if (!payload) return res.status(401).json({ message: "This link is invalid or has expired" });
    const loaded = await loadAckDoc(payload);
    if (!loaded) return res.status(404).json({ message: "Document not found" });
    const venue = await Venue.findById(loaded.doc.venue).select("name logo").lean();
    const d = loaded.doc;
    return res.status(200).json({
      docType: loaded.kind,
      venue: { name: venue && venue.name, logo: venue && venue.logo },
      partyName: loaded.partyName || "",
      lineItems: d.lineItems,
      gstMode: d.gstMode,
      gstPercent: d.gstPercent,
      discount: d.discount,
      totals: d.totals,
      terms: d.terms || [],
      status: d.status,
      acceptedAt: d.acceptance && d.acceptance.at,
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/doc-ack/:token — {name, phone, channel} phone-verified accept.
const acceptDoc = async (req, res) => {
  try {
    const payload = verifyDocToken(req.params.token);
    if (!payload) return res.status(401).json({ message: "This link is invalid or has expired" });
    const loaded = await loadAckDoc(payload);
    if (!loaded) return res.status(404).json({ message: "Document not found" });
    const d = loaded.doc;
    if (d.acceptance && d.acceptance.at) return res.status(409).json({ message: "This document has already been accepted" });
    if (!["sent", "draft"].includes(d.status)) return res.status(409).json({ message: "This document is no longer open for acceptance" });

    const nameV = reqStr((req.body || {}).name, "name", 200);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const phoneV = optStr((req.body || {}).phone, "phone", 30);
    if (!phoneV.ok) return res.status(400).json({ message: phoneV.message });
    const channel = (req.body || {}).channel === "whatsapp" ? "whatsapp" : "link";
    const given = last10(phoneV.value);
    const expected = last10(loaded.partyPhone);
    if (!given || given.length < 10) return res.status(400).json({ message: "A valid phone number is required" });
    if (!expected) return res.status(409).json({ message: "This document has no phone on record — contact the venue" });
    if (given !== expected) return res.status(403).json({ message: "The phone number does not match this document" });

    d.acceptance = { name: nameV.value, phone: phoneV.value, at: new Date(), channel };
    d.status = "accepted";
    await d.save();
    return res.status(200).json({ success: true, acceptedAt: d.acceptance.at });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/quotes/:quoteId/send-ack — mint an acceptance token for a
// quote (quotes keep their existing status flow; this only issues the link).
const sendQuoteAck = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    if (!["draft", "sent"].includes(quote.status)) return res.status(409).json({ message: `A ${quote.status} quote cannot be sent for acceptance` });
    if (!quote.lineItems.length) return res.status(400).json({ message: "Cannot send a quote with no line items" });
    if (quote.status === "draft") { quote.status = "sent"; await quote.save(); }
    const token = jwt.sign({ type: "venue_doc_ack", docType: "quote", docId: String(quote._id) }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return res.status(200).json({ quote, ackToken: token, ackPath: `/doc-ack?token=${token}` });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  createBill,
  listBills,
  updateBill,
  sendBill,
  convertBill,
  billPdf,
  getAckDoc,
  acceptDoc,
  sendQuoteAck,
};

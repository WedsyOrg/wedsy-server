/**
 * controllers/venueInvoice.js — Phase 3 (3.3) GST invoices.
 * Routes under /venues/:slug/invoices (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueInvoice = require("../models/VenueInvoice");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueCounter = require("../models/VenueCounter");
const { computeTotals, GST_MODES } = require("../utils/venueMoney");
const { streamInvoicePdf } = require("../utils/venuePdf");
const { isOwnerActor } = require("../utils/venueRbac");
const VenueTeamMember = require("../models/VenueTeamMember");

async function resolveOwnedVenue(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

function paymentStatus(grandTotal, received) {
  if (received <= 0) return "unpaid";
  if (received >= grandTotal) return "paid";
  return "partially_paid";
}

// Allocate the per-venue invoice number and create the invoice doc — the ONE
// numbering path (D8: bill conversion reuses it; the sequence machinery is
// untouched). Atomic per-venue sequence: lazy-init the counter to the current
// max seq so it never collides with pre-existing/seeded invoices, then
// allocate via an atomic $inc. Returns the created invoice; throws on the
// (extremely unlikely) triple allocation collision.
async function allocateInvoice(venue, fields) {
  const prefix = venue.invoicePrefix || "INV-";
  const counterKey = `${venue._id}:invoice`;
  const maxDoc = await VenueInvoice.findOne({ venue: venue._id }).sort({ seq: -1 }).select("seq").lean();
  try {
    await VenueCounter.updateOne({ key: counterKey }, { $setOnInsert: { seq: maxDoc ? maxDoc.seq : 0 } }, { upsert: true });
  } catch (e) { if (e.code !== 11000) throw e; } // concurrent first-init race — fine
  for (let attempt = 0; attempt < 3; attempt++) {
    const seq = await VenueCounter.next(counterKey);
    const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;
    try {
      return await VenueInvoice.create({ ...fields, venue: venue._id, invoiceNumber, seq });
    } catch (e) {
      if (e.code === 11000 && attempt < 2) continue; // allocate next
      throw e;
    }
  }
  const err = new Error("Could not allocate an invoice number, please retry");
  err.statusCode = 409;
  throw err;
}

// POST /venues/:slug/invoices — create-from-booking.
const createFromBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id invoicePrefix");
    if (!venue) return;
    const { booking, kind, lineItems, gstPercent, gstMode, discount, terms } = req.body || {};
    if (!booking) return res.status(400).json({ message: "booking is required" });
    const bookingDoc = await VenueBooking.findOne({ _id: booking, venue: venue._id }).lean();
    if (!bookingDoc) return res.status(404).json({ message: "Booking not found for this venue" });
    if (gstMode !== undefined && !GST_MODES.includes(gstMode)) {
      return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    }
    if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || t.length > 2000) || terms.length > 50)) {
      return res.status(400).json({ message: "terms must be an array of strings (max 50 × 2000 chars)" });
    }

    // Line items: explicit body > latest accepted quote for the enquiry > single line from booking total.
    let items = Array.isArray(lineItems) ? lineItems : null;
    let pct = gstPercent !== undefined ? Number(gstPercent) : 18;
    let disc = Number(discount) || 0;
    let mode = gstMode || "exclusive";
    if (!items && bookingDoc.enquiry) {
      const quote = await VenueQuote.findOne({ enquiry: bookingDoc.enquiry, status: "accepted" }).sort({ version: -1 }).lean()
        || await VenueQuote.findOne({ enquiry: bookingDoc.enquiry }).sort({ version: -1 }).lean();
      if (quote) { items = quote.lineItems; pct = quote.gstPercent; disc = quote.discount; if (!gstMode && quote.gstMode) mode = quote.gstMode; }
    }
    if (!items) items = [{ label: "Venue booking", category: "venue_hire", qty: 1, unitPrice: bookingDoc.totalValue || 0 }];
    const totals = computeTotals(items, pct, disc, mode);

    const KINDS = ["advance", "final", "addon"];
    const invoice = await allocateInvoice(venue, {
      booking: bookingDoc._id,
      kind: KINDS.includes(kind) ? kind : "advance",
      lineItems: items,
      gstPercent: pct,
      gstMode: mode,
      discount: disc,
      totals,
      terms: Array.isArray(terms) ? terms : [],
      status: "unpaid",
      payments: [],
    });
    return res.status(201).json({ invoice });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message });
  }
};

const listInvoices = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    if (req.query.booking) filter.booking = req.query.booking;
    const invoices = await VenueInvoice.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ invoices, total: invoices.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const getInvoice = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id }).lean();
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    return res.status(200).json({ invoice });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// D7: only approved entries count as received money. Pending entries still
// block over-recording (they claim balance) but never move rollups/status.
function sumPayments(invoice, statuses) {
  return (invoice.payments || []).reduce((s, p) => {
    const st = p.status || "approved"; // pre-D7 entries backfill-read approved
    return statuses.includes(st) ? s + (Number(p.amount) || 0) : s;
  }, 0);
}

function recomputeInvoiceStatus(invoice) {
  invoice.status = paymentStatus(invoice.totals.grandTotal, sumPayments(invoice, ["approved"]));
}

// POST /venues/:slug/invoices/:invoiceId/payments — record a payment (D7).
// Owner-recorded -> auto-approved + permanent "Owner entry" label.
// Member-recorded -> pending_approval, excluded from rollups until approved.
const addPayment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const { amount, mode, note, date, collectedBy, proofUrl } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "amount must be a positive number" });
    if (date != null && date !== "" && Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ message: "date is not valid" });
    }
    const ALLOWED_MODES = ["bank_transfer", "cash", "cheque", "upi", "card"];
    if (mode != null && !ALLOWED_MODES.includes(mode)) return res.status(400).json({ message: "invalid payment mode" });
    if (collectedBy !== undefined && (typeof collectedBy !== "string" || collectedBy.length > 200)) {
      return res.status(400).json({ message: "collectedBy must be a string (max 200 chars)" });
    }
    if (proofUrl !== undefined && (typeof proofUrl !== "string" || proofUrl.length > 2000)) {
      return res.status(400).json({ message: "proofUrl must be a string (max 2000 chars)" });
    }
    // Over-recording guard counts pending + approved (both claim the balance).
    const already = sumPayments(invoice, ["approved", "pending_approval"]);
    const balanceBefore = invoice.totals.grandTotal - already;
    if (amt > balanceBefore) {
      return res.status(400).json({ message: `payment exceeds outstanding balance (${balanceBefore})`, balance: balanceBefore });
    }

    const ownerActor = await isOwnerActor(req.venueOwner, req.venueMember);
    let recordedByName = "";
    if (!ownerActor && req.venueOwner.memberId) {
      const m = await VenueTeamMember.findById(req.venueOwner.memberId).select("name").lean();
      recordedByName = (m && m.name) || "team member";
    }
    invoice.payments.push({
      amount: amt,
      mode: mode || "bank_transfer",
      note: String(note || "").slice(0, 2000),
      date: date ? new Date(date) : new Date(),
      recordedByType: ownerActor ? "owner" : "member",
      recordedById: req.venueOwner.memberId || req.venueOwner.venueOwnerId || undefined,
      recordedByName: ownerActor ? "Owner" : recordedByName,
      collectedBy: String(collectedBy || "").trim(),
      proofUrl: String(proofUrl || "").trim(),
      status: ownerActor ? "approved" : "pending_approval",
      ownerEntry: ownerActor,
      approvedByName: ownerActor ? "Owner" : "",
      approvedAt: ownerActor ? new Date() : undefined,
    });
    recomputeInvoiceStatus(invoice);
    await invoice.save();
    const received = sumPayments(invoice, ["approved"]);
    const entry = invoice.payments[invoice.payments.length - 1];
    return res.status(200).json({ invoice, payment: entry, received, balance: invoice.totals.grandTotal - received });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/invoices/:invoiceId/payments/:paymentId/approve — owner only.
const approvePayment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if (!(await isOwnerActor(req.venueOwner, req.venueMember))) {
      return res.status(403).json({ message: "Only the owner can approve payments" });
    }
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const entry = invoice.payments.id(req.params.paymentId);
    if (!entry) return res.status(404).json({ message: "Payment entry not found" });
    if ((entry.status || "approved") !== "pending_approval") {
      return res.status(409).json({ message: `Payment is ${entry.status || "approved"}, not pending` });
    }
    entry.status = "approved";
    entry.approvedByName = "Owner";
    entry.approvedAt = new Date();
    recomputeInvoiceStatus(invoice);
    await invoice.save();
    return res.status(200).json({ invoice, payment: entry, received: sumPayments(invoice, ["approved"]) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/invoices/:invoiceId/payments/:paymentId/reject — owner only.
// Rejected entries stay for audit but never count anywhere.
const rejectPayment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if (!(await isOwnerActor(req.venueOwner, req.venueMember))) {
      return res.status(403).json({ message: "Only the owner can reject payments" });
    }
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const entry = invoice.payments.id(req.params.paymentId);
    if (!entry) return res.status(404).json({ message: "Payment entry not found" });
    if ((entry.status || "approved") !== "pending_approval") {
      return res.status(409).json({ message: `Payment is ${entry.status || "approved"}, not pending` });
    }
    entry.status = "rejected";
    entry.rejectedReason = String((req.body || {}).reason || "").slice(0, 2000);
    recomputeInvoiceStatus(invoice);
    await invoice.save();
    return res.status(200).json({ invoice, payment: entry });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/invoices/:invoiceId/pdf
const invoicePdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "name address formattedAddress contact phone email gstin pan logo");
    if (!venue) return;
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id }).lean();
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const booking = await VenueBooking.findById(invoice.booking).select("coupleName couplePhone").lean();
    await streamInvoicePdf(res, { venue, booking, invoice });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createFromBooking, listInvoices, getInvoice, addPayment, approvePayment, rejectPayment, invoicePdf, allocateInvoice, sumPayments };

/**
 * controllers/venueInvoice.js — Phase 3 (3.3) GST invoices.
 * Routes under /venues/:slug/invoices (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueInvoice = require("../models/VenueInvoice");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueCounter = require("../models/VenueCounter");
const { computeTotals } = require("../utils/venueMoney");
const { streamInvoicePdf } = require("../utils/venuePdf");

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

// POST /venues/:slug/invoices — create-from-booking.
const createFromBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id invoicePrefix");
    if (!venue) return;
    const { booking, kind, lineItems, gstPercent, discount } = req.body || {};
    if (!booking) return res.status(400).json({ message: "booking is required" });
    const bookingDoc = await VenueBooking.findOne({ _id: booking, venue: venue._id }).lean();
    if (!bookingDoc) return res.status(404).json({ message: "Booking not found for this venue" });

    // Line items: explicit body > latest accepted quote for the enquiry > single line from booking total.
    let items = Array.isArray(lineItems) ? lineItems : null;
    let pct = gstPercent !== undefined ? Number(gstPercent) : 18;
    let disc = Number(discount) || 0;
    if (!items && bookingDoc.enquiry) {
      const quote = await VenueQuote.findOne({ enquiry: bookingDoc.enquiry, status: "accepted" }).sort({ version: -1 }).lean()
        || await VenueQuote.findOne({ enquiry: bookingDoc.enquiry }).sort({ version: -1 }).lean();
      if (quote) { items = quote.lineItems; pct = quote.gstPercent; disc = quote.discount; }
    }
    if (!items) items = [{ label: "Venue booking", category: "venue_hire", qty: 1, unitPrice: bookingDoc.totalValue || 0 }];
    const totals = computeTotals(items, pct, disc);

    // Atomic per-venue invoice sequence (no read-modify-write race). Lazy-init the
    // counter to the current max seq so it never collides with pre-existing/seeded
    // invoices, then allocate via an atomic $inc.
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
        const invoice = await VenueInvoice.create({
          venue: venue._id,
          booking: bookingDoc._id,
          invoiceNumber,
          seq,
          kind: kind === "final" ? "final" : "advance",
          lineItems: items,
          gstPercent: pct,
          discount: disc,
          totals,
          status: "unpaid",
          payments: [],
        });
        return res.status(201).json({ invoice });
      } catch (e) {
        if (e.code === 11000 && attempt < 2) continue; // extremely unlikely; allocate next
        throw e;
      }
    }
    return res.status(409).json({ message: "Could not allocate an invoice number, please retry" });
  } catch (err) { return res.status(500).json({ message: err.message }); }
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

// POST /venues/:slug/invoices/:invoiceId/payments — record a payment.
const addPayment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const invoice = await VenueInvoice.findOne({ _id: req.params.invoiceId, venue: venue._id });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const { amount, mode, note, date } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "amount must be a positive number" });
    if (date != null && date !== "" && Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ message: "date is not valid" });
    }
    const ALLOWED_MODES = ["bank_transfer", "cash", "cheque", "upi", "card"];
    if (mode != null && !ALLOWED_MODES.includes(mode)) return res.status(400).json({ message: "invalid payment mode" });
    // Reject overpayment: a single payment may not exceed the outstanding balance.
    const already = invoice.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const balanceBefore = invoice.totals.grandTotal - already;
    if (amt > balanceBefore) {
      return res.status(400).json({ message: `payment exceeds outstanding balance (${balanceBefore})`, balance: balanceBefore });
    }
    invoice.payments.push({ amount: amt, mode: mode || "bank_transfer", note: String(note || "").slice(0, 2000), date: date ? new Date(date) : new Date() });
    const received = invoice.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    invoice.status = paymentStatus(invoice.totals.grandTotal, received);
    await invoice.save();
    return res.status(200).json({ invoice, received, balance: invoice.totals.grandTotal - received });
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

module.exports = { createFromBooking, listInvoices, getInvoice, addPayment, invoicePdf };

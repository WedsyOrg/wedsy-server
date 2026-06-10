/**
 * controllers/venueQuote.js — Phase 3 (3.2) versioned quotes + PDF + quote→booking.
 * Routes under /venues/:slug/quotes (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueQuote = require("../models/VenueQuote");
const VenueEnquiry = require("../models/VenueEnquiry");
const { computeTotals } = require("../utils/venueMoney");
const { streamQuotePdf } = require("../utils/venuePdf");
const { createDraftBookingForEnquiry } = require("./venueBooking");

async function resolveOwnedVenue(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

// POST /venues/:slug/quotes — create a new quote version for an enquiry.
const createQuote = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { enquiry, lineItems, gstPercent, discount } = req.body || {};
    if (!enquiry) return res.status(400).json({ message: "enquiry is required" });
    const enquiryDoc = await VenueEnquiry.findOne({ _id: enquiry, venueId: venue._id }).select("_id").lean();
    if (!enquiryDoc) return res.status(404).json({ message: "Enquiry not found for this venue" });

    const pct = gstPercent !== undefined ? Number(gstPercent) : 18;
    const disc = Number(discount) || 0;
    const totals = computeTotals(lineItems, pct, disc);

    // Next version + supersede earlier non-final versions.
    const latest = await VenueQuote.findOne({ enquiry }).sort({ version: -1 }).select("version").lean();
    const version = (latest ? latest.version : 0) + 1;
    await VenueQuote.updateMany(
      { enquiry, status: { $in: ["draft", "sent"] } },
      { status: "superseded" }
    );

    const quote = await VenueQuote.create({
      venue: venue._id,
      enquiry,
      version,
      lineItems: Array.isArray(lineItems) ? lineItems : [],
      gstPercent: pct,
      discount: disc,
      totals,
      status: "draft",
    });
    return res.status(201).json({ quote });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/quotes[?enquiry=]
const listQuotes = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    if (req.query.enquiry) filter.enquiry = req.query.enquiry;
    const quotes = await VenueQuote.find(filter).sort({ enquiry: 1, version: -1 }).lean();
    return res.status(200).json({ quotes, total: quotes.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const getQuote = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id }).lean();
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    return res.status(200).json({ quote });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/quotes/:quoteId — edit line items/status. Recomputes totals.
// When status transitions to "accepted", create/update the draft booking.
const updateQuote = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    const { lineItems, gstPercent, discount, status } = req.body || {};
    if (lineItems !== undefined) quote.lineItems = Array.isArray(lineItems) ? lineItems : [];
    if (gstPercent !== undefined) quote.gstPercent = Number(gstPercent);
    if (discount !== undefined) quote.discount = Number(discount) || 0;
    if (lineItems !== undefined || gstPercent !== undefined || discount !== undefined) {
      quote.totals = computeTotals(quote.lineItems, quote.gstPercent, quote.discount);
    }
    if (status !== undefined) quote.status = status;
    await quote.save();

    let booking = null;
    if (status === "accepted") {
      const enquiry = await VenueEnquiry.findOne({ _id: quote.enquiry, venueId: venue._id });
      if (enquiry) {
        booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);
        booking.totalValue = quote.totals.grandTotal;
        await booking.save();
      }
    }
    return res.status(200).json({ quote, booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/quotes/:quoteId/pdf
const quotePdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "name address formattedAddress contact phone email");
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id }).lean();
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    const enquiry = await VenueEnquiry.findById(quote.enquiry).select("coupleName name couplePhone").lean();
    streamQuotePdf(res, { venue, enquiry, quote });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createQuote, listQuotes, getQuote, updateQuote, quotePdf };

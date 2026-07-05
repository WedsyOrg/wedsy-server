/**
 * controllers/venueQuote.js — Phase 3 (3.2) versioned quotes + PDF + quote→booking.
 * Routes under /venues/:slug/quotes (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueQuote = require("../models/VenueQuote");
const VenueEnquiry = require("../models/VenueEnquiry");
const { computeTotals, GST_MODES } = require("../utils/venueMoney");
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
    const venue = await resolveOwnedVenue(req, res, "_id settings");
    if (!venue) return;
    const { enquiry, lineItems, gstPercent, gstMode, discount, terms, whiteLabel } = req.body || {};
    if (!enquiry) return res.status(400).json({ message: "enquiry is required" });
    if (whiteLabel !== undefined && typeof whiteLabel !== "boolean") {
      return res.status(400).json({ message: "whiteLabel must be a boolean" });
    }
    const enquiryDoc = await VenueEnquiry.findOne({ _id: enquiry, venueId: venue._id }).select("_id").lean();
    if (!enquiryDoc) return res.status(404).json({ message: "Enquiry not found for this venue" });

    const pct = gstPercent !== undefined ? Number(gstPercent) : 18;
    const disc = Number(discount) || 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
    if (!Number.isFinite(disc) || disc < 0) return res.status(400).json({ message: "discount must be >= 0" });
    if (gstMode !== undefined && !GST_MODES.includes(gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || t.length > 2000) || terms.length > 50)) {
      return res.status(400).json({ message: "terms must be an array of strings (max 50 × 2000 chars)" });
    }
    const mode = gstMode || "exclusive";
    const totals = computeTotals(lineItems, pct, disc, mode);

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
      gstMode: mode,
      // E3x: explicit per-doc flag wins; otherwise the venue-level default.
      whiteLabel: whiteLabel !== undefined ? whiteLabel : !!(venue.settings && venue.settings.documentsWhiteLabelDefault),
      discount: disc,
      totals,
      terms: Array.isArray(terms) ? terms : [],
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
    const { lineItems, gstPercent, gstMode, discount, status, terms, whiteLabel } = req.body || {};
    if (gstMode !== undefined && !GST_MODES.includes(gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    if (whiteLabel !== undefined && typeof whiteLabel !== "boolean") {
      return res.status(400).json({ message: "whiteLabel must be a boolean" });
    }
    if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || t.length > 2000) || terms.length > 50)) {
      return res.status(400).json({ message: "terms must be an array of strings (max 50 × 2000 chars)" });
    }
    const QUOTE_STATUS = ["draft", "sent", "accepted", "superseded"];
    if (status !== undefined && !QUOTE_STATUS.includes(status)) {
      return res.status(400).json({ message: `status must be one of ${QUOTE_STATUS.join(", ")}` });
    }
    if (gstPercent !== undefined && (!Number.isFinite(Number(gstPercent)) || Number(gstPercent) < 0 || Number(gstPercent) > 100)) {
      return res.status(400).json({ message: "gstPercent must be 0..100" });
    }
    if (discount !== undefined && (!Number.isFinite(Number(discount)) || Number(discount) < 0)) {
      return res.status(400).json({ message: "discount must be >= 0" });
    }
    // A quote with no line items cannot be accepted.
    const effItems = lineItems !== undefined ? (Array.isArray(lineItems) ? lineItems : []) : quote.lineItems;
    if (status === "accepted" && (!effItems || effItems.length === 0)) {
      return res.status(400).json({ message: "cannot accept a quote with no line items" });
    }
    if (lineItems !== undefined) quote.lineItems = Array.isArray(lineItems) ? lineItems : [];
    if (gstPercent !== undefined) quote.gstPercent = Number(gstPercent);
    if (gstMode !== undefined) quote.gstMode = gstMode;
    if (discount !== undefined) quote.discount = Number(discount) || 0;
    if (terms !== undefined) quote.terms = terms;
    if (whiteLabel !== undefined) quote.whiteLabel = whiteLabel;
    if (lineItems !== undefined || gstPercent !== undefined || discount !== undefined || gstMode !== undefined) {
      quote.totals = computeTotals(quote.lineItems, quote.gstPercent, quote.discount, quote.gstMode);
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

// POST /venues/:slug/quotes/:quoteId/confirm-booking — the owner action behind
// the "Quote accepted — confirm booking" card. Public acceptance never
// auto-creates the booking (D5); this converts an accepted quote into the
// draft booking exactly like the owner-marked acceptance path (idempotent:
// one booking per enquiry).
const confirmBookingFromQuote = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    if (quote.status !== "accepted") return res.status(409).json({ message: `Quote is ${quote.status}, not accepted` });
    const enquiry = await VenueEnquiry.findOne({ _id: quote.enquiry, venueId: venue._id });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found for this venue" });
    const booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);
    booking.totalValue = quote.totals.grandTotal;
    await booking.save();
    return res.status(200).json({ quote, booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/quotes/:quoteId/pdf
const quotePdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "name address formattedAddress contact phone email logo");
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id }).lean();
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    const enquiry = await VenueEnquiry.findById(quote.enquiry).select("coupleName name couplePhone").lean();
    await streamQuotePdf(res, { venue, enquiry, quote });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createQuote, listQuotes, getQuote, updateQuote, confirmBookingFromQuote, quotePdf };

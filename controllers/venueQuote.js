/**
 * controllers/venueQuote.js — Phase 3 (3.2) versioned quotes + PDF + quote→booking.
 * Routes under /venues/:slug/quotes (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueQuote = require("../models/VenueQuote");
const { computeTotals, computeLineTotals, GST_MODES } = require("../utils/venueMoney");
const { checkChargeMoney } = require("../utils/venueBookingCharges");
const { streamQuotePdf } = require("../utils/venuePdf");
const { createDraftBookingForEnquiry } = require("./venueBooking");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { syncQuotedValue } = require("../utils/venueQuotedValue");
const VenueEnquiry = require("../models/VenueEnquiry");

/**
 * ── THE LINES ARE THE NUMBER (founder ruling) ───────────────────────────────
 * A saved line quote writes through to VenueEnquiry.estimatedValue — the one
 * materialised figure the pipeline, dashboards, pricing intel and both OS
 * projections read — via the SAME sync the rounds use. The sync's precedence
 * (booking > latest line quote's CHARGED > latest round with an amount) makes
 * the rounds' own calls no-ops the moment a line quote exists; the
 * negotiation records what was said, the lines are what is billed. The
 * activity line makes the move auditable, exactly as round-driven moves are.
 */
async function writeQuoteThrough(enquiryId, quote, actorId) {
  const lead = await VenueEnquiry.findById(enquiryId);
  if (!lead) return;
  const sync = await syncQuotedValue(lead);
  if (sync.changed) {
    lead.activities.push({
      type: "quote_changed",
      // "(quote vN)" — the version says which quote; the owner does not need
      // the implementation named (founder ruling: no "as lines" in owner copy).
      description: `Quote updated to ₹${sync.to.toLocaleString("en-IN")} (quote v${quote.version || 1})`,
      actor: actorId || null,
      timestamp: new Date(),
    });
    await lead.save();
  }
}

/**
 * ── THE QUOTE DOOR, CLOSED (moneypost slice 1) ──────────────────────────────
 * createDraftBookingForEnquiry returns the EXISTING booking even when it has
 * been confirmed and its payment schedule built. Accepting a fresh quote
 * version then let applyQuoteToBooking overwrite the confirmed booking's
 * lineItems and totalValue with NO schedule reconciliation — the PATCH-time
 * schedule guard never fires because paymentSchedule is not in that body —
 * silently breaking Σ schedule === payable.
 *
 * The rule: once a booking has money structure (any schedule row), a quote
 * acceptance may not rewrite it. The sanctioned path is the post-booking line
 * edit, which absorbs the difference into the unpaid instalments with the
 * owner confirming the before/after.
 */
async function refuseIfBookingHasSchedule(res, enquiryId) {
  const VenueBooking = require("../models/VenueBooking");
  const existing = await VenueBooking.findOne({ enquiry: enquiryId }).select("paymentSchedule status").lean();
  if (existing && (existing.paymentSchedule || []).length > 0 && existing.status !== "cancelled") {
    res.status(409).json({
      message:
        "This lead's booking is already confirmed and its payment schedule is built. " +
        "Accepting a quote cannot rewrite it — edit the booking's lines from the Money tab; " +
        "the difference absorbs into the unpaid instalments after you confirm the change.",
      code: "booking_has_schedule",
    });
    return true;
  }
  return false;
}

async function resolveOwnedVenue(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

// ── MONEY LINES: one payload, one mode ──────────────────────────────────────
// A quote is LINE-MODE when its items carry the new money facts (amount, GST
// treatment, refundable), LEGACY when they carry qty × unitPrice and nothing
// new. A payload mixing the two shapes is refused rather than guessed at: a
// row that half-says what it means would get whichever math noticed it first.
const isLineShaped = (li) =>
  li && (li.amount !== undefined || li.gstTreatment !== undefined || li.refundable !== undefined || li.taxableAmount !== undefined);

const LINE_CATEGORIES = ["venue_hire", "catering", "decoration", "accommodation", "other"];

/**
 * Validate + normalize a line-mode payload. qty/unitPrice are MIRRORED
 * (qty 1, unitPrice = amount) so every existing renderer and the invoice
 * precedence that read qty × unitPrice keep totalling correctly, unmodified.
 * @returns {{ ok: true, lines: Array } | { ok: false, message: string }}
 */
function normalizeQuoteLines(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const li = items[i] || {};
    const where = `lineItems[${i}]`;
    if (!isLineShaped(li)) {
      return { ok: false, message: `${where}: every line on a line quote needs an amount and a GST treatment — this one has neither` };
    }
    const label = String(li.label || "").trim().slice(0, 120);
    if (!label) return { ok: false, message: `${where}: a line needs a label` };
    if (li.amount === undefined || li.amount === null || li.amount === "") {
      return { ok: false, message: `${where}: a line needs an amount` };
    }
    const money = checkChargeMoney(li, where);
    if (!money.ok) return money;
    out.push({
      label,
      category: LINE_CATEGORIES.includes(li.category) ? li.category : "other",
      qty: 1,
      unitPrice: money.value.amount,
      perDay: false,
      day: null,
      amount: money.value.amount,
      gstTreatment: money.value.gstTreatment,
      taxableAmount: money.value.taxableAmount,
      refundable: money.value.refundable,
      source: { chargeKey: String((li.source && li.source.chargeKey) || "").slice(0, 60) },
    });
  }
  return { ok: true, lines: out };
}

/** A stored quote is line-mode when its rows carry a treatment. */
const storedLineMode = (quote) => (quote.lineItems || []).some((li) => li.gstTreatment);

/**
 * ── THE VALUE A QUOTE HANDS A BOOKING — the unit-mismatch fix ───────────────
 * VenueBooking.totalValue is declared GST-EXCLUSIVE ("totalValue stays what
 * was NEGOTIATED… plus GST, derived per row" — models/VenueBooking.js), but
 * acceptance wrote quote.totals.grandTotal, which under the default
 * "exclusive" mode INCLUDES the GST. Every quote left at 18% exclusive and
 * accepted wrote an inflated totalValue into the four revenue sums, the
 * pipeline write-back, pricing-intel comparables and the schedule's spread
 * base — and a booking GST mode set later taxed the inflated figure AGAIN.
 *
 * totals.taxable is the ex-GST base under all three document modes (exclusive:
 * the base itself; inclusive: base − the GST inside it; none: the base), so it
 * is the one figure that matches the booking's declaration. A LINE quote's
 * ex-GST figure is totals.charged — same declaration, and the refundable
 * deposit additionally kept out of revenue.
 *
 * scripts/assess-quote-accept-gst-seam.js counts what the old seam already
 * stored; remediation of stored data is the founder's decision, not code's.
 */
function bookingValueFromQuote(quote) {
  const totals = quote.totals || {};
  return storedLineMode(quote) ? totals.charged || 0 : totals.taxable || 0;
}

/**
 * ── THE SEAM: what acceptance hands the booking ─────────────────────────────
 * One function for both call sites (the accepted PATCH and the dashboard's
 * confirm-booking), because two seams that drift is how the last defect
 * shipped twice.
 *
 * A LINE quote's booking gets:
 *   · the LINES, snapshotted — the deal's frozen facts, exactly as accepted
 *   · totalValue = CHARGED (ex-GST, refundable excluded) — the revenue figure
 *     every scalar consumer reads
 *   · gstPercent copied — the one rate the line treatments apply
 *   · gstMode FORCED "none" (ruling A): the lines own the GST, and the
 *     per-instalment machinery must not be able to tax the same money twice.
 *     Two GST systems on one booking is the exact shape of bug this project
 *     keeps shipping.
 * A LEGACY quote's booking gets the ex-GST value and nothing else new.
 */
function applyQuoteToBooking(booking, quote) {
  booking.totalValue = bookingValueFromQuote(quote);
  if (storedLineMode(quote)) {
    booking.lineItems = (quote.lineItems || []).map((li) => ({
      label: li.label || "",
      amount: Math.round(Number(li.amount) || 0),
      gstTreatment: li.gstTreatment || "none",
      taxableAmount: Math.round(Number(li.taxableAmount) || 0),
      refundable: Boolean(li.refundable),
      source: { chargeKey: (li.source && li.source.chargeKey) || "" },
    }));
    booking.gstPercent = Number(quote.gstPercent) || 0;
    booking.gstMode = "none";
  }
}

/**
 * The two document-mode knobs a line quote refuses. GST comes from each
 * line's treatment against the one rate, so a document gstMode has nothing to
 * say; and a document discount would be a number outside the lines on a quote
 * whose rule is "everything is a line" — adjust the line amounts instead.
 */
function lineModeConflicts({ gstMode, discount }) {
  if (gstMode !== undefined && gstMode !== "exclusive") {
    return "A line quote's GST comes from each line's treatment — gstMode does not apply.";
  }
  if (discount !== undefined && Number(discount) !== 0) {
    return "On a line quote there is no document discount — adjust the line amounts instead.";
  }
  return null;
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
    // Scoped: a member can only quote a lead they can see, and never a
    // soft-deleted one (resolveScopedEnquiry is the single boundary + 404-not-403).
    const enquiryDoc = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiry, { select: "_id", lean: true });
    if (!enquiryDoc) return res.status(404).json({ message: "Enquiry not found for this venue" });

    const pct = gstPercent !== undefined ? Number(gstPercent) : 18;
    const disc = Number(discount) || 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
    if (!Number.isFinite(disc) || disc < 0) return res.status(400).json({ message: "discount must be >= 0" });
    if (gstMode !== undefined && !GST_MODES.includes(gstMode)) return res.status(400).json({ message: `gstMode must be one of ${GST_MODES.join(", ")}` });
    if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || t.length > 2000) || terms.length > 50)) {
      return res.status(400).json({ message: "terms must be an array of strings (max 50 × 2000 chars)" });
    }

    // ── which math this quote gets, decided once ────────────────────────────
    const lineMode = Array.isArray(lineItems) && lineItems.some(isLineShaped);
    let items = Array.isArray(lineItems) ? lineItems : [];
    let mode = gstMode || "exclusive";
    let totals;
    if (lineMode) {
      const conflict = lineModeConflicts({ gstMode, discount });
      if (conflict) return res.status(400).json({ message: conflict });
      const norm = normalizeQuoteLines(items);
      if (!norm.ok) return res.status(400).json({ message: norm.message });
      items = norm.lines;
      mode = "exclusive";
      totals = computeLineTotals(items, pct);
    } else {
      totals = computeTotals(items, pct, disc, mode);
    }

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
      lineItems: items,
      gstPercent: pct,
      gstMode: mode,
      // E3x: explicit per-doc flag wins; otherwise the venue-level default.
      whiteLabel: whiteLabel !== undefined ? whiteLabel : !!(venue.settings && venue.settings.documentsWhiteLabelDefault),
      discount: disc,
      totals,
      terms: Array.isArray(terms) ? terms : [],
      status: "draft",
    });
    await writeQuoteThrough(enquiry, quote, req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId));
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
    // Refused BEFORE any write: an acceptance that half-lands (quote flipped,
    // booking untouched) would claim a deal state the booking does not hold.
    if (status === "accepted" && (await refuseIfBookingHasSchedule(res, quote.enquiry))) return;

    // ── which math, decided from the EFFECTIVE items ────────────────────────
    // A legacy quote may be upgraded to lines by sending line-shaped items; a
    // line quote never silently degrades — sending legacy-shaped items to one
    // is refused, because the flip would drop every treatment and flag the
    // owner set and the totals would quietly change meaning.
    const payloadLineMode = lineItems !== undefined && effItems.some(isLineShaped);
    const effLineMode = lineItems !== undefined ? payloadLineMode : storedLineMode(quote);
    if (storedLineMode(quote) && lineItems !== undefined && !payloadLineMode && effItems.length > 0) {
      return res.status(400).json({ message: "This is a line quote — every line needs an amount and a GST treatment." });
    }
    let normalizedLines = null;
    if (effLineMode) {
      const conflict = lineModeConflicts({ gstMode, discount });
      if (conflict) return res.status(400).json({ message: conflict });
      if (lineItems !== undefined) {
        const norm = normalizeQuoteLines(effItems);
        if (!norm.ok) return res.status(400).json({ message: norm.message });
        normalizedLines = norm.lines;
      }
    }

    if (lineItems !== undefined) quote.lineItems = normalizedLines || (Array.isArray(lineItems) ? lineItems : []);
    if (gstPercent !== undefined) quote.gstPercent = Number(gstPercent);
    if (gstMode !== undefined) quote.gstMode = gstMode;
    if (discount !== undefined) quote.discount = Number(discount) || 0;
    if (terms !== undefined) quote.terms = terms;
    if (whiteLabel !== undefined) quote.whiteLabel = whiteLabel;
    if (lineItems !== undefined || gstPercent !== undefined || discount !== undefined || gstMode !== undefined) {
      quote.totals = effLineMode
        ? computeLineTotals(quote.lineItems, quote.gstPercent)
        : computeTotals(quote.lineItems, quote.gstPercent, quote.discount, quote.gstMode);
    }
    if (status !== undefined) quote.status = status;
    await quote.save();
    await writeQuoteThrough(quote.enquiry, quote, req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId));

    let booking = null;
    if (status === "accepted") {
      const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, quote.enquiry);
      if (enquiry) {
        booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);
        applyQuoteToBooking(booking, quote);
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
    if (await refuseIfBookingHasSchedule(res, quote.enquiry)) return;
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, quote.enquiry);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found for this venue" });
    const booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);
    applyQuoteToBooking(booking, quote);
    await booking.save();
    return res.status(200).json({ quote, booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/quotes/:quoteId/pdf
const quotePdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "name address formattedAddress contact phone email logo tagline gstin pan settings");
    if (!venue) return;
    const quote = await VenueQuote.findOne({ _id: req.params.quoteId, venue: venue._id }).lean();
    if (!quote) return res.status(404).json({ message: "Quote not found" });
    // Scoped like the other enquiry reads: never render a lead the requester
    // cannot see (or a soft-deleted one) into a PDF.
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, quote.enquiry, { select: "coupleName name couplePhone checkIn checkOut requirements", lean: true });
    // The document system: the venue's chosen language, every document.
    const { buildVenueDocument } = require("../utils/docsystem");
    const { loadLogoBuffer } = require("../utils/venuePdf");
    const logoBuffer = await loadLogoBuffer(venue.logo);
    // a booked lead's quote also prints the rooms RECORD off its booking
    const bookingForDoc = enquiry ? await require("../models/VenueBooking").findOne({ enquiry: enquiry._id })
      .select("roomsAllocation checkIn checkOut days").lean() : null;
    const built = await buildVenueDocument("quote", { venue, lead: enquiry, quote, booking: bookingForDoc, logoBuffer });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="quote-v${quote.version || 1}.pdf"`);
    return res.end(built.buffer);
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createQuote, listQuotes, getQuote, updateQuote, confirmBookingFromQuote, quotePdf, normalizeQuoteLines };

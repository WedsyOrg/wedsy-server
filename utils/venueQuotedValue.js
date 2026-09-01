/**
 * utils/venueQuotedValue.js — keeping ONE current-quote figure.
 *
 * ── THE AUDIT THIS FILE EXISTS TO SATISFY ───────────────────────────────────
 * "What did we quote?" is read from VenueEnquiry.estimatedValue in 8 files
 * outside tests, and several of those reads are Mongo-level:
 *
 *   controllers/venueCrmDashboard.js  inPipelineValue (the pipeline TOTAL),
 *                                     per-lead value rows, today's site visit
 *   controllers/venueCrmDay.js        quotedValue on every day-view row
 *   utils/venueContention.js          selected onto competing-lead rows
 *   controllers/venueBooking.js       seeds VenueBooking.totalValue on create,
 *                                     and writes BACK on confirm
 *   controllers/venueEnquiry.js       create + update + CSV import
 *   controllers/adminVenueLeads.js    OS projection
 *   controllers/adminVenueOps.js      OS projection
 *
 * The two OS projections and the dashboard aggregate cannot call a JavaScript
 * helper because they run as `.select()` / `$project` inside the database. So
 * estimatedValue REMAINS the single materialised figure, and the authoritative
 * object WRITES THROUGH to it. Pointing those readers at the source object
 * instead would mean re-deriving the line math inside Mongo aggregation — a
 * second implementation of the money rules, which is the exact drift the
 * one-scalar design exists to prevent.
 *
 * ── PRECEDENCE (founder ruling, money lines) ────────────────────────────────
 *   1. A CONFIRMED BOOKING wins. controllers/venueBooking writes
 *      estimatedValue back from booking.totalValue on confirm; once money is
 *      committed the booking is the real number. This helper is not called on
 *      booked leads.
 *   2. THE LATEST LINE QUOTE wins next — its CHARGED figure (ex-GST, the
 *      refundable deposit excluded). The lines are the number; the
 *      negotiation records what was said on a call. The current offer is the
 *      newest un-superseded version — draft, sent or accepted (acceptance
 *      alone does not flip the stage, and dropping back to the round figure
 *      at that moment would move the number backwards; confirm's write-back
 *      takes over from there).
 *   3. Otherwise the latest ROUND carrying an amount — the legacy rule, still
 *      the truth for leads that have never had a line quote. Rounds STOP
 *      writing through the moment a line quote exists: their sync calls keep
 *      running and this precedence makes them no-ops.
 *   4. If neither says anything, estimatedValue is left ALONE — a hand-typed
 *      figure survives until something authoritative supersedes it.
 */
const VenueQuoteRound = require("../models/VenueQuoteRound");

/** The amount the thread currently implies, or null when it implies nothing. */
async function latestQuotedAmount(enquiryId) {
  const row = await VenueQuoteRound.findOne({ enquiry: enquiryId, amount: { $ne: null } })
    .sort({ createdAt: -1 })
    .select("amount")
    .lean();
  return row && typeof row.amount === "number" ? row.amount : null;
}

/**
 * The CHARGED figure of the lead's current line quote, or null when the lead
 * has none. Line-mode = rows carrying a gstTreatment (the same test the quote
 * controller applies). Draft, sent or accepted — the newest version wins;
 * superseded ones never rule.
 */
async function latestLineQuoteCharged(enquiryId) {
  // Required lazily: venueQuote's controller requires this module's caller
  // chain, and a top-level require would be a cycle waiting to happen.
  const VenueQuote = require("../models/VenueQuote");
  const quote = await VenueQuote.findOne({ enquiry: enquiryId, status: { $in: ["draft", "sent", "accepted"] } })
    .sort({ version: -1 })
    .select("lineItems totals")
    .lean();
  if (!quote || !(quote.lineItems || []).some((li) => li.gstTreatment)) return null;
  const charged = quote.totals && typeof quote.totals.charged === "number" ? quote.totals.charged : null;
  return charged;
}

/**
 * Push the authoritative figure onto the lead. Mutates and SAVES the lead
 * only when the number actually changes, so this is safe to call after every
 * round OR quote write.
 *
 * @param {object} enquiry a mongoose VenueEnquiry doc
 * @returns {Promise<{changed:boolean, from:number, to:number, source:string}>}
 */
async function syncQuotedValue(enquiry) {
  const from = Number(enquiry.estimatedValue) || 0;
  // Rule 1 — a booked lead's number belongs to its booking.
  if (enquiry.stage === "booked") return { changed: false, from, to: from, source: "booking" };

  // Rule 2 — the lines are the number.
  const charged = await latestLineQuoteCharged(enquiry._id);
  const source = charged !== null ? "lines" : "round";
  const amount = charged !== null ? charged : await latestQuotedAmount(enquiry._id);

  // Rule 4 — nothing to say, so say nothing.
  if (amount === null) return { changed: false, from, to: from, source };
  if (amount === from) return { changed: false, from, to: from, source };

  enquiry.estimatedValue = amount;
  await enquiry.save();
  return { changed: true, from, to: amount, source };
}

module.exports = { latestQuotedAmount, latestLineQuoteCharged, syncQuotedValue };

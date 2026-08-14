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
 * Making the thread a second authority — "the real number is the latest round,
 * go and look it up" — would mean touching all of those, and the two OS
 * projections and the dashboard aggregate cannot call a JavaScript helper
 * because they run as `.select()` / `$group` inside the database.
 *
 * So: estimatedValue REMAINS the single current-quote figure, and quote rounds
 * WRITE THROUGH to it. The thread is the narrative that explains the number;
 * the number stays exactly where every consumer already looks. Nothing in the
 * audit list changes at all.
 *
 * ── PRECEDENCE, stated once ─────────────────────────────────────────────────
 *   1. A CONFIRMED BOOKING wins. controllers/venueBooking already writes
 *      estimatedValue back from booking.totalValue on confirm, and that is
 *      correct — once money is committed, the booking is the real number and a
 *      later stray round must not silently contradict it. This helper is not
 *      called on booked leads.
 *   2. Otherwise the latest round CARRYING AN AMOUNT wins. Rounds with no
 *      amount (a discount request logged before re-quoting) are skipped —
 *      they move the story, not the price.
 *   3. If no round has an amount, estimatedValue is left ALONE. A thread that
 *      is nothing but "they asked for a discount" must not zero out a figure a
 *      human typed.
 *
 * Direct edits to estimatedValue keep working; the next round with an amount
 * supersedes them, which is the same rule a human would apply out loud.
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
 * Push the thread's current figure onto the lead. Mutates and SAVES the lead
 * only when the number actually changes, so this is safe to call after every
 * round write.
 *
 * @param {object} enquiry a mongoose VenueEnquiry doc
 * @returns {Promise<{changed:boolean, from:number, to:number}>}
 */
async function syncQuotedValue(enquiry) {
  const from = Number(enquiry.estimatedValue) || 0;
  // Rule 1 — a booked lead's number belongs to its booking.
  if (enquiry.stage === "booked") return { changed: false, from, to: from };

  const amount = await latestQuotedAmount(enquiry._id);
  // Rule 3 — nothing to say, so say nothing.
  if (amount === null) return { changed: false, from, to: from };
  if (amount === from) return { changed: false, from, to: from };

  enquiry.estimatedValue = amount;
  await enquiry.save();
  return { changed: true, from, to: amount };
}

module.exports = { latestQuotedAmount, syncQuotedValue };

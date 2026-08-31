#!/usr/bin/env node
/**
 * scripts/assess-quote-accept-gst-seam.js — DRY RUN ONLY, never writes.
 * House convention: assess, report, do not apply.
 *
 * ── THE DEFECT BEING COUNTED ────────────────────────────────────────────────
 * The acceptance seam (controllers/venueQuote.js, both the status:"accepted"
 * PATCH and POST /quotes/:id/confirm-booking) wrote
 *
 *     booking.totalValue = quote.totals.grandTotal
 *
 * and grandTotal is GST-INCLUSIVE under the quote's default "exclusive" mode,
 * while VenueBooking.totalValue is declared GST-EXCLUSIVE (models/
 * VenueBooking.js). Every quote left at the default 18% exclusive and then
 * accepted wrote a totalValue inflated by the GST — into the four revenue
 * sums, pricing-intel comparables, the estimatedValue write-back, the
 * schedule's spread base, and the statement's "recorded exclusive of GST"
 * sentence. The S3 code fix writes the ex-GST figure instead; THIS script
 * reports what the old seam already stored.
 *
 * Remediation means re-agreeing money with a couple, so it is a business
 * decision and not something a script should do — same stance as
 * assess-schedule-balance-semantics.
 *
 * ── HOW A BOOKING IS CLASSIFIED (exported, so the suite can prove it) ───────
 *   no_accepted_quote  — no accepted quote on the enquiry; the seam never ran
 *   no_gst_on_quote    — the accepted quote's grandTotal equals its taxable
 *                        (gst 0 / mode none): the seam wrote a correct number
 *   inflated           — totalValue === grandTotal ≠ taxable: the defect,
 *                        delta = grandTotal − taxable is the inflation
 *   matches_taxable    — totalValue === taxable: already the ex-GST figure
 *                        (hand-corrected, or written after the S3 fix)
 *   drifted            — totalValue matches neither: edited by hand since;
 *                        reported, not judged
 *
 * Run: DATABASE_URL=... node scripts/assess-quote-accept-gst-seam.js
 */
require("dotenv").config();

/** Pure classifier — the suite requires this and proves each verdict. */
function classifyBooking(booking, acceptedQuote) {
  if (!acceptedQuote || !acceptedQuote.totals) return { verdict: "no_accepted_quote" };
  const grand = Math.round(Number(acceptedQuote.totals.grandTotal) || 0);
  const taxable = Math.round(Number(acceptedQuote.totals.taxable) || 0);
  const value = Math.round(Number(booking.totalValue) || 0);
  if (grand === taxable) return { verdict: "no_gst_on_quote", grand, taxable, value };
  if (value === grand) return { verdict: "inflated", grand, taxable, value, delta: grand - taxable };
  if (value === taxable) return { verdict: "matches_taxable", grand, taxable, value };
  return { verdict: "drifted", grand, taxable, value };
}

async function main() {
  const mongoose = require("mongoose");
  const VenueBooking = require("../models/VenueBooking");
  const VenueQuote = require("../models/VenueQuote");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const bookings = await VenueBooking.find({ enquiry: { $ne: null } })
    .select("venue enquiry totalValue coupleName createdAt")
    .lean();

  const counts = { no_accepted_quote: 0, no_gst_on_quote: 0, inflated: 0, matches_taxable: 0, drifted: 0 };
  const inflated = [];
  const drifted = [];
  for (const b of bookings) {
    // The latest ACCEPTED version: acceptance survives supersession (only
    // draft/sent are superseded by a new version), so newest-accepted is the
    // one the seam last wrote from.
    const q = await VenueQuote.findOne({ enquiry: b.enquiry, status: "accepted" })
      .sort({ version: -1 })
      .select("version totals gstMode gstPercent")
      .lean();
    const c = classifyBooking(b, q);
    counts[c.verdict] += 1;
    if (c.verdict === "inflated") {
      inflated.push({
        booking: String(b._id),
        venue: String(b.venue),
        couple: b.coupleName || "",
        quoteVersion: q.version,
        gst: `${q.gstMode || "exclusive"} @ ${q.gstPercent}%`,
        totalValue: c.value,
        exGst: c.taxable,
        delta: c.delta,
        createdAt: b.createdAt,
      });
    } else if (c.verdict === "drifted") {
      drifted.push({ booking: String(b._id), totalValue: c.value, grand: c.grand, exGst: c.taxable });
    }
  }

  console.log(`Bookings with an enquiry: ${bookings.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  if (inflated.length) {
    console.log(`\nINFLATED — totalValue carries the quote's GST (delta = the inflation):`);
    for (const r of inflated) {
      console.log(
        `  ${r.booking}  ${r.couple || "(no name)"}  v${r.quoteVersion} ${r.gst}  ` +
          `totalValue ${r.totalValue}  ex-GST ${r.exGst}  delta +${r.delta}  ${new Date(r.createdAt).toISOString().slice(0, 10)}`
      );
    }
    console.log(`\nRemediation is re-agreeing money with each couple — a business decision. Nothing was changed.`);
  } else {
    console.log(`\nNo inflated bookings found. Nothing was changed.`);
  }
  if (drifted.length) {
    console.log(`\nDRIFTED — totalValue matches neither figure (edited by hand since; listed for completeness):`);
    for (const r of drifted) console.log(`  ${r.booking}  totalValue ${r.totalValue}  quote grand ${r.grand} / ex-GST ${r.exGst}`);
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
}

module.exports = { classifyBooking };

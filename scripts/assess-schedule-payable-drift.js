#!/usr/bin/env node
/**
 * scripts/assess-schedule-payable-drift.js — DRY RUN ONLY, never writes.
 * House convention: assess, report, do not apply.
 *
 * ── THE DEFECT BEING COUNTED ────────────────────────────────────────────────
 * Until moneypost slice 1, accepting a fresh quote version on a lead whose
 * booking was ALREADY CONFIRMED overwrote the confirmed booking's lineItems
 * and totalValue (controllers/venueQuote.js → applyQuoteToBooking via
 * createDraftBookingForEnquiry, which returns the existing booking) with no
 * schedule reconciliation. The invariant for line bookings —
 *
 *     Σ non-additional schedule rows === charged + refundable (payable)
 *
 * — is enforced at confirm and on any PATCH carrying paymentSchedule, but the
 * quote-accept path bypassed both. This script reports what that door already
 * let through. Remediation means re-agreeing money with a couple, so it is a
 * business decision and not something a script should do.
 *
 * ── HOW A BOOKING IS CLASSIFIED (exported, so a suite can prove it) ─────────
 *   no_lines      — legacy booking (no lineItems): the line invariant does
 *                   not apply to it; NOT counted as drift
 *   no_schedule   — line booking with no schedule rows (money-less confirm):
 *                   the invariant is vacuous; NOT counted as drift
 *   consistent    — Σ non-additional rows === charged + refundable
 *   drifted       — the mismatch this door produced; delta = scheduled − payable
 *
 * A drifted row also reports whether the enquiry carries an accepted quote
 * whose totals disagree with the booking's own lines — the fingerprint of the
 * quote-accept overwrite — versus drift from some other hand. The two need
 * different conversations; do not read the combined count as one defect.
 *
 * Run: DATABASE_URL=... node scripts/assess-schedule-payable-drift.js
 */
require("dotenv").config();

const { computeLineTotals } = require("../utils/venueMoney");

/** Pure classifier — no I/O, provable in a suite. */
function classifyBooking(booking, acceptedQuote) {
  const lines = (booking && booking.lineItems) || [];
  if (!lines.length) return { verdict: "no_lines" };
  const rows = (booking && booking.paymentSchedule) || [];
  if (!rows.length) return { verdict: "no_schedule" };
  const lf = computeLineTotals(lines, booking.gstPercent);
  const payable = lf.charged + lf.refundable;
  const scheduled = rows
    .filter((r) => !(r && r.isAdditional))
    .reduce((s, r) => s + (Math.round(Number(r && r.amount)) || 0), 0);
  if (scheduled === payable) return { verdict: "consistent", scheduled, payable };
  const qCharged = acceptedQuote && acceptedQuote.totals && Math.round(Number(acceptedQuote.totals.charged) || 0);
  const quoteFingerprint = Boolean(
    acceptedQuote && typeof qCharged === "number" && qCharged === lf.charged
  );
  return {
    verdict: "drifted",
    scheduled,
    payable,
    delta: scheduled - payable,
    // TRUE = the booking's lines match the newest accepted quote while the
    // schedule was built over something older: the quote-accept overwrite.
    // FALSE = the lines match no accepted quote: drift from some other hand.
    quoteFingerprint,
  };
}

async function main() {
  const mongoose = require("mongoose");
  const VenueBooking = require("../models/VenueBooking");
  const VenueQuote = require("../models/VenueQuote");
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 15000 });
  console.log("assess-schedule-payable-drift — DRY RUN, nothing will be written.\n");

  const bookings = await VenueBooking.find({ status: { $ne: "cancelled" } })
    .select("enquiry lineItems paymentSchedule gstPercent totalValue coupleName")
    .lean();
  const counts = { no_lines: 0, no_schedule: 0, consistent: 0, drifted: 0 };
  const drifted = [];
  for (const b of bookings) {
    const quote = await VenueQuote.findOne({ enquiry: b.enquiry, status: "accepted" })
      .sort({ version: -1 }).select("totals version").lean();
    const c = classifyBooking(b, quote);
    counts[c.verdict]++;
    if (c.verdict === "drifted") drifted.push({ b, c });
  }

  console.log(`bookings assessed (cancelled excluded): ${bookings.length}`);
  console.log(`  no_lines    (legacy — the line invariant does NOT apply): ${counts.no_lines}`);
  console.log(`  no_schedule (line booking, money-less confirm — invariant vacuous): ${counts.no_schedule}`);
  console.log(`  consistent  (Σ non-additional rows === charged + refundable): ${counts.consistent}`);
  console.log(`  drifted     (the mismatch — schedule ≠ payable): ${counts.drifted}`);

  if (drifted.length) {
    console.log(
      `\nDRIFTED rows. delta = scheduled − payable; positive means the schedule collects MORE` +
      ` than the lines say, negative means less. "quote-accept fingerprint" means the booking's` +
      ` lines match the newest accepted quote while the schedule was built over something older` +
      ` — the closed door's signature; "other hand" matches no accepted quote and needs its own reading:`
    );
    for (const { b, c } of drifted) {
      console.log(
        `  ${b._id}  ${(b.coupleName || "").slice(0, 24).padEnd(24)}` +
        ` scheduled ${c.scheduled}  payable ${c.payable}  delta ${c.delta >= 0 ? "+" : ""}${c.delta}` +
        `  [${c.quoteFingerprint ? "quote-accept fingerprint" : "other hand"}]`
      );
    }
    console.log(`\nRemediation means re-agreeing money with a couple — a business decision. Nothing was changed.`);
  } else {
    console.log(`\nNo drifted bookings found. Nothing was changed.`);
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

// MONEY LINES S3 — the acceptance seam and the guards around the two figures.
// Run: DATABASE_URL=... node tests/venue-money-seam.test.js
//
// The load-bearing claims:
//   · DEFECT 1: acceptance writes the EX-GST figure into totalValue — never
//     grandTotal — under all three document modes, at BOTH call sites.
//   · A line quote's acceptance writes CHARGED (ex-GST, refundable excluded).
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");

const quotes = require("../controllers/venueQuote");
const bookings = require("../controllers/venueBooking");

const TAG = `mseam-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

let venue, owner;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
  venueMember: null,
});
const mkLead = () => VenueEnquiry.create({
  venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`, stage: "negotiating",
});

/** File a quote, accept it via PATCH, return the booking the seam wrote. */
async function acceptQuote(quoteBody) {
  const lead = await mkLead();
  let r = await call(quotes.createQuote, req({ body: { enquiry: String(lead._id), ...quoteBody } }));
  if (r.code !== 201) return { error: r };
  r = await call(quotes.updateQuote, req({ params: { quoteId: String(r.body.quote._id) }, body: { status: "accepted" } }));
  return { res: r, lead, quote: r.body && r.body.quote, booking: r.body && r.body.booking };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, spaces: [{ name: "Hall", isBookable: true }] });
    created.venues.push(venue._id);
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ══ A. DEFECT 1 — the seam writes the EX-GST figure ═════════════════════
    console.log("\n[A. acceptance writes ex-GST, never grandTotal — all three modes, both call sites]");

    // exclusive @18: 1,00,000 base → grand 1,18,000. The old seam wrote 1,18,000.
    let a = await acceptQuote({ gstPercent: 18, gstMode: "exclusive", lineItems: [{ label: "Venue", qty: 1, unitPrice: 100000 }] });
    eq(a.res.code, 200, "exclusive quote accepts");
    eq(a.quote.totals.grandTotal, 118000, "the quote's grand total IS GST-inclusive (the trap)");
    eq(a.booking.totalValue, 100000, "🔴 DEFECT 1 FIXED: totalValue is the ex-GST base, not the 1,18,000 the old seam wrote");

    // inclusive @5: 50,000 all-in → taxable 47,619. The declaration wins.
    a = await acceptQuote({ gstPercent: 5, gstMode: "inclusive", lineItems: [{ label: "Venue", qty: 1, unitPrice: 50000 }] });
    eq(a.booking.totalValue, 47619, "🔴 inclusive: the all-in 50,000 stores as its ex-GST part — the model's declaration");

    // none: base is base.
    a = await acceptQuote({ gstPercent: 0, gstMode: "none", lineItems: [{ label: "Venue", qty: 1, unitPrice: 80000 }] });
    eq(a.booking.totalValue, 80000, "none: the base, unchanged");

    // discount still lands ex-GST: 1,00,000 − 10,000 @18 exclusive → 90,000.
    a = await acceptQuote({ gstPercent: 18, discount: 10000, lineItems: [{ label: "Venue", qty: 1, unitPrice: 100000 }] });
    eq(a.booking.totalValue, 90000, "a discounted legacy quote writes the discounted ex-GST base");

    // A LINE quote writes CHARGED: refundable excluded, GST excluded.
    a = await acceptQuote({
      gstPercent: 18,
      lineItems: [
        { label: "Venue", amount: 500000, gstTreatment: "full" },
        { label: "Decor", amount: 200000, gstTreatment: "part", taxableAmount: 50000 },
        { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
      ],
    });
    eq(a.res.code, 200, "a line quote accepts");
    eq(a.quote.totals.grandTotal, 824000, "…its grand total carries GST and the deposit");
    eq(a.booking.totalValue, 700000, "🔴 the booking's totalValue is CHARGED — no GST, no deposit — the revenue figure");

    // The SECOND call site: confirm-booking from an already-accepted quote.
    const lead2 = await mkLead();
    let r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead2._id), gstPercent: 18, gstMode: "exclusive", lineItems: [{ label: "Venue", qty: 1, unitPrice: 200000 }] },
    }));
    await VenueQuote.updateOne({ _id: r.body.quote._id }, { status: "accepted" });
    r = await call(quotes.confirmBookingFromQuote, req({ params: { quoteId: String(r.body.quote._id) } }));
    eq(r.code, 200, "confirm-booking-from-quote answers");
    eq(r.body.booking.totalValue, 200000, "🔴 the dashboard's call site writes ex-GST too — both seams, one helper");

    // ══ B. THE SEAM CARRIES THE LINES ═══════════════════════════════════════
    console.log("\n[B. a line quote's booking carries the lines, the rate, and gstMode none]");
    a = await acceptQuote({
      gstPercent: 18,
      lineItems: [
        { label: "Venue", amount: 500000, gstTreatment: "full" },
        { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true, source: { chargeKey: "security_deposit" } },
      ],
    });
    let bk = await VenueBooking.findById(a.booking._id).lean();
    eq(bk.lineItems.length, 2, "🔴 the lines are ON the booking — snapshotted at acceptance");
    const dep = bk.lineItems.find((l) => l.refundable);
    ok(dep && dep.amount === 25000 && dep.gstTreatment === "none" && dep.source.chargeKey === "security_deposit",
      "…the deposit line keeps amount, treatment, flag and breadcrumb");
    eq(bk.totalValue, 500000, "totalValue is charged — the deposit is not in it");
    eq(bk.gstPercent, 18, "the quote's one rate rides along");
    eq(bk.gstMode, "none", "🔴 RULING A: gstMode is FORCED none — the lines own the GST, the row machinery cannot double-tax");

    // A LEGACY acceptance stays exactly as it was: no lines, gst untouched.
    a = await acceptQuote({ gstPercent: 18, gstMode: "exclusive", lineItems: [{ label: "Venue", qty: 1, unitPrice: 100000 }] });
    bk = await VenueBooking.findById(a.booking._id).lean();
    eq((bk.lineItems || []).length, 0, "a legacy quote's booking carries NO lines");
    eq(bk.gstMode, "none", "…and its gstMode is the model default, written by nothing here");
    eq(bk.gstPercent, 0, "…rate likewise untouched (the confirm wizard sets booking GST, not the seam)");

    // ── the wizard's own payload shape, verbatim from its guard test ────────
    let dayCursor = 1;
    const nextDate = () => `2094-0${Math.ceil(dayCursor / 28)}-${String(((dayCursor++ - 1) % 28) + 1).padStart(2, "0")}`;
    const fn = (date) => [{ date, name: "Wedding", space: String(venue.spaces[0]._id) }];
    const confirmLead = async (lead, body) =>
      call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(lead._id) }, body }));

    // ══ C. NON-LINE BOOKINGS: TODAY'S GATES, BYTE-IDENTICAL ═════════════════
    console.log("\n[C. the guard that once never ran keeps BOTH its gates for non-line bookings]");
    // Gate 1: amounts-only schedules skip the guard entirely — a stated total
    // that disagrees with the rows STILL lands. Today's shipped behaviour,
    // asserted rather than assumed.
    let lead = await mkLead();
    r = await confirmLead(lead, {
      functions: fn(nextDate()), tokenAmount: 10000, totalValue: 100000,
      paymentSchedule: [{ label: "Only", amount: 50000 }],
    });
    eq(r.code, 200, "🔴 GATE 1 UNCHANGED: amounts-only + mismatched stated total sails through, as shipped");
    bk = await VenueBooking.findOne({ enquiry: lead._id }).lean();
    eq(bk.totalValue, 100000, "…and the stated value is what lands (60,000 scheduled against it — the gate's own gap)");

    // Gate 2: percentages but NO stated total — the guard has nothing to check
    // against and the total derives from token + rows (invariant #7).
    lead = await mkLead();
    r = await confirmLead(lead, {
      functions: fn(nextDate()), tokenAmount: 25000,
      paymentSchedule: [{ label: "A", percent: 50, amount: 37500 }, { label: "B", percent: 50, amount: 37500 }],
    });
    eq(r.code, 200, "🔴 GATE 2 UNCHANGED: percentages with no stated total pass — nothing to check against");
    bk = await VenueBooking.findOne({ enquiry: lead._id }).lean();
    eq(bk.totalValue, 100000, "…and the total DERIVES from token + rows, exactly as before");

    // Both gates open: the guard fires with its original payload shape.
    lead = await mkLead();
    r = await confirmLead(lead, {
      functions: fn(nextDate()), tokenAmount: 25000, totalValue: 100000,
      paymentSchedule: [{ label: "A", percent: 50, amount: 50000 }, { label: "B", percent: 50, amount: 50000 }],
    });
    eq(r.code, 400, "the 125%-shape still refuses when both gates are open");
    eq(r.body.code, "schedule_value_mismatch", "…same code");
    eq(r.body.bookingValue, 100000, "…same fields");
    ok(r.body.payable === undefined && r.body.refundableHeld === undefined,
      "🔴 …and NO new fields — the non-line refusal payload is byte-identical");

    // ══ D. LINE BOOKINGS: the refusals are REACHABLE, the guard is gateless ══
    console.log("\n[D. a real wizard call hits total_is_derived_from_lines; the line guard needs no gate]");
    // A line quote accepted → the draft carries lines: charged 5,00,000 (venue,
    // GST full) + refundable 25,000 deposit. Payable 5,25,000.
    a = await acceptQuote({
      gstPercent: 18,
      lineItems: [
        { label: "Venue", amount: 500000, gstTreatment: "full" },
        { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
      ],
    });
    const lineLead = a.lead;

    // REACHABILITY: the confirm wizard's exact payload shape — functions,
    // tokenAmount, totalValue, percentage schedule — with the owner's typed
    // total disagreeing with the lines. A refusal nobody can trigger is the
    // same failure family as a guard that never runs.
    r = await confirmLead(lineLead, {
      functions: fn(nextDate()), tokenAmount: 25000, totalValue: 480000,
      paymentSchedule: [{ label: "A", percent: 50, amount: 227500 }, { label: "B", percent: 50, amount: 227500 }],
    });
    eq(r.code, 400, "🔴 REACHABLE: the wizard-shaped payload with a disagreeing total is refused");
    eq(r.body.code, "total_is_derived_from_lines", "…with the ruled code");
    ok(r.body.chargedFromLines === 500000 && r.body.refundableHeld === 25000 && r.body.statedTotal === 480000,
      "…and BOTH numbers, so the owner is told, not overridden");

    // The gateless guard: amounts-only, NO stated total — the exact shape that
    // sails through gate 1 for non-line bookings — is caught, because the
    // schedule forgot the deposit.
    r = await confirmLead(lineLead, {
      functions: fn(nextDate()), paymentSchedule: [{ label: "Full", amount: 500000 }],
    });
    eq(r.code, 400, "🔴 GATELESS: amounts-only with no stated total is checked anyway — lines are the truth");
    eq(r.body.code, "schedule_value_mismatch", "…same code as ever");
    ok(/refundable held/.test(r.body.message) && /add it as a row/.test(r.body.message),
      `…and the message says what to add: "${r.body.message}"`);
    eq(r.body.payable, 525000, "…naming the payable: charged + refundable");

    // Ruling A at the door: booking-level GST modes are refused on line bookings.
    r = await confirmLead(lineLead, {
      functions: fn(nextDate()), gstMode: "whole", gstPercent: 18,
      paymentSchedule: [{ label: "Full", amount: 525000 }],
    });
    eq(r.code, 400, "a booking-level GST mode is refused on a line booking");
    eq(r.body.code, "line_booking_gst", "…with its own code");

    // The echo is a no-op, and the whole flow works through today's wizard: the
    // owner adds the deposit as a FIXED row, percentages split the rest.
    r = await confirmLead(lineLead, {
      functions: fn(nextDate()), tokenAmount: 25000, totalValue: 500000, gstMode: "none", gstPercent: 0,
      paymentSchedule: [
        { label: "Security deposit", amount: 25000 },
        { label: "A", percent: 50, amount: 237500 },
        { label: "B", percent: 50, amount: 237500 },
      ],
    });
    eq(r.code, 200, "🔴 the wizard echoing the derived value is a no-op, not an error — and the deposit rides as a fixed row");
    bk = await VenueBooking.findOne({ enquiry: lineLead._id }).lean();
    eq(bk.totalValue, 500000, "totalValue stays charged");
    eq(bk.gstMode, "none", "gstMode stays none");
    eq(bk.gstPercent, 18, "🔴 …and the wizard's gstPercent 0 echo did NOT wipe the quote's rate");

    // ── PATCH takes the same three rules, or it is the bypass ──
    const bkId = String(bk._id);
    r = await call(bookings.updateBooking, req({ params: { bookingId: bkId }, body: { totalValue: 999999 } }));
    eq(r.code, 400, "PATCH totalValue that disagrees is refused");
    eq(r.body.code, "total_is_derived_from_lines", "…same code as confirm");
    r = await call(bookings.updateBooking, req({ params: { bookingId: bkId }, body: { paymentSchedule: [{ label: "Full", amount: 500000 }] } }));
    eq(r.code, 400, "PATCH schedule that forgets the deposit is refused");
    r = await call(bookings.updateBooking, req({
      params: { bookingId: bkId },
      body: { paymentSchedule: [{ label: "Full", amount: 525000 }, { label: "Bar tab", amount: 10000, isAdditional: true }] },
    }));
    eq(r.code, 200, "🔴 …but additional billing stays the sanctioned money above the value — excluded from the equality");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueBooking.deleteMany({ venue: { $in: created.venues } });
      await VenueQuote.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();

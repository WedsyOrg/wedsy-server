// MONEY LINES S4 — the read surfaces: held money is owed, never earned.
// Run: DATABASE_URL=... node tests/venue-money-figures.test.js
//
// The load-bearing claims:
//   · summarizeSchedule reports TWO figures: charged (revenue) and total
//     (charged + refundable held). balance runs against total — the couple
//     owes the deposit — and no revenue figure ever contains it.
//   · venuePayment's confirmedValue counts CHARGED, and a booking WITH a
//     refundable line reports the same charged revenue as one without.
//   · The statement is a dispute record: "Total payable" includes the held
//     deposit, with Rohaan's exact line — "of which refundable, held —
//     returned after the event" — as its own line.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const payments = require("../controllers/venuePayment");
const st = require("../controllers/venueLeadStatement");
const { buildStatementPdf } = require("../utils/venueStatementPdf");
const { buildBookingConfirmationPdf } = require("../utils/venueBookingConfirmationPdf");

const TAG = `mfig-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };
/**
 * PDF text search: the renderer writes hex-encoded TJ runs (compress:false),
 * so decode every run, concatenate, and compare space-stripped — kerning
 * splits words, and a phrase must not fail because of a spacing array.
 */
function pdfTextOf(buffer) {
  const runs = [];
  const raw = buffer.toString("latin1");
  for (const arr of raw.match(/\[(.*?)\]\s*TJ/gs) || []) {
    for (const hex of arr.match(/<([0-9a-fA-F]+)>/g) || []) {
      runs.push(Buffer.from(hex.slice(1, -1), "hex"));
    }
  }
  return Buffer.concat(runs).toString("latin1").replace(/\s+/g, "");
}
const has = (buffer, text) => pdfTextOf(buffer).includes(String(text).replace(/\s+/g, ""));

let venue;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
  venueMember: null,
});

const LINES = [
  { label: "Venue hire", amount: 500000, gstTreatment: "full", taxableAmount: 0, refundable: false },
  { label: "Security deposit", amount: 25000, gstTreatment: "none", taxableAmount: 0, refundable: true, source: { chargeKey: "security_deposit" } },
];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      gstin: "29ABCDE1234F1Z5",
    });
    created.venues.push(venue._id);

    const mkLead = () => VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`, stage: "booked",
    });

    const leadA = await mkLead();
    // Booking A: LINE booking — charged 5,00,000 + refundable 25,000 held.
    // The schedule collects the deposit too (the S3 guard's rule), and one
    // entry has arrived against the deposit row.
    const bookingA = await VenueBooking.create({
      venue: venue._id, enquiry: leadA._id, coupleName: `${TAG} A`, totalValue: 500000,
      lineItems: LINES, gstMode: "none", gstPercent: 18,
      days: [{ date: new Date(Date.now() + 40 * 86400000), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [
        { label: "Security deposit", amount: 25000, entries: [{ amount: 25000, status: "approved" }] },
        { label: "Balance", amount: 500000 },
      ],
    });
    const leadB = await mkLead();
    // Booking B: the SAME deal without the deposit line — the control.
    const bookingB = await VenueBooking.create({
      venue: venue._id, enquiry: leadB._id, coupleName: `${TAG} B`, totalValue: 500000,
      days: [{ date: new Date(Date.now() + 50 * 86400000), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [{ label: "Balance", amount: 500000 }],
    });

    // ══ A. summarizeSchedule: the two figures ═══════════════════════════════
    console.log("\n[A. charged vs total — held money is owed, never earned]");
    const sA = summarizeSchedule(bookingA);
    eq(sA.totals.charged, 500000, "🔴 charged is the revenue figure — the deposit is NOT in it");
    eq(sA.totals.refundable, 25000, "🔴 the refundable held is its own figure, derived from the lines");
    eq(sA.totals.total, 525000, "🔴 Total payable includes the held deposit");
    eq(sA.totals.balance, 500000, "balance runs against payable: 5,25,000 owed − 25,000 received");
    ok(sA.totals.scheduleMatchesValue, "a schedule that collects the deposit MATCHES the payable");
    const sB = summarizeSchedule(bookingB);
    eq(sB.totals.charged, sB.totals.total, "a booking without lines: charged === total, additive fields change nothing");
    eq(sB.totals.refundable, 0, "…and refundable is 0, not undefined");

    // ══ B. venuePayment: the sum that would have silently miscounted ════════
    console.log("\n[B. confirmedValue counts CHARGED — a deposit is not confirmed revenue]");
    let r = await call(payments.summary, req());
    eq(r.code, 200, "payments summary answers");
    eq(r.body.totals.confirmedValue, 1000000,
      "🔴 THE STORED FIGURE: confirmedValue is 10,00,000 — the 25,000 held is NOT counted as confirmed revenue");
    const rowA = r.body.perBooking.find((p) => String(p.bookingId) === String(bookingA._id));
    const rowB = r.body.perBooking.find((p) => String(p.bookingId) === String(bookingB._id));
    eq(rowA.totalValue, rowB.totalValue,
      "🔴 a booking WITH a refundable line reports charged revenue UNCHANGED from one without");
    eq(rowA.total, 525000, "…while its payable says what the couple actually pays");
    eq(rowA.refundable, 25000, "…and names the held part");
    eq(rowB.refundable, 0, "the control booking holds nothing");
    eq(r.body.totals.payable, 1025000, "venue payable = charged + held");
    eq(r.body.totals.pending, 1000000, "pending = payable − received (25,000 deposit already in) — never negative from held money");

    // ══ C. the statement preview — the dispute record's numbers ═════════════
    console.log("\n[C. the statement states the deposit and the lines' GST]");
    r = await call(st.previewStatement, req({ params: { enquiryId: String(leadA._id) } }));
    eq(r.code, 200, "preview answers");
    const pv = r.body.preview;
    eq(pv.charged, 500000, "preview carries charged");
    eq(pv.refundable, 25000, "…and the refundable held");
    eq(pv.total, 525000, "…inside Total payable");
    eq(pv.gst.mode, "lines", "🔴 a line booking's GST is stated FROM THE LINES (gstMode is none by ruling A)");
    eq(pv.gst.amount, 90000, "…18% on the taxable 5,00,000");
    ok(/quoted lines/.test(pv.gst.note), `…and the note says so: "${pv.gst.note}"`);

    // ══ D. the PDFs — Rohaan's exact wording, on the page ═══════════════════
    console.log("\n[D. the documents say it in the ruled words]");
    const stBuilt = await buildStatementPdf({ venue: venue.toObject(), booking: bookingA.toObject(), summary: sA, invoices: [], lead: leadA.toObject() });
    ok(stBuilt.buffer.slice(0, 5).toString() === "%PDF-", "the statement is a real PDF");
    ok(has(stBuilt.buffer, "of which refundable, held"), "🔴 RULING B: 'of which refundable, held' is on the statement");
    ok(has(stBuilt.buffer, "returned after the event"), "🔴 …'returned after the event', Rohaan's exact words");
    ok(has(stBuilt.buffer, "Total payable"), "…under a 'Total payable' that includes the deposit");
    ok(has(stBuilt.buffer, "Venue hire"), "…and the lines themselves are itemised");
    ok(has(stBuilt.buffer, "refundable, held"), "…with the deposit row labelled as held");
    ok(has(stBuilt.buffer, "of the quoted lines"), "…and GST stated from the lines");
    eq(stBuilt.gstStated, "lines", "the generator reports gstStated 'lines'");

    // The control: a booking with no lines renders exactly the old vocabulary.
    const stPlain = await buildStatementPdf({ venue: venue.toObject(), booking: bookingB.toObject(), summary: sB, invoices: [], lead: leadB.toObject() });
    ok(!has(stPlain.buffer, "of which refundable"), "a booking without a deposit says nothing about one");
    eq(stPlain.gstStated, "none", "…and its GST sentence is the shipped one");

    const cfBuilt = await buildBookingConfirmationPdf({ venue: venue.toObject(), booking: bookingA.toObject(), lead: leadA.toObject() });
    ok(has(cfBuilt.buffer, "of which refundable, held"), "🔴 the booking confirmation carries the same line");
    ok(has(cfBuilt.buffer, "returned after the event"), "…same exact words");
    ok(has(cfBuilt.buffer, "Venue hire"), "…and itemises the lines instead of the Venue/Rooms subtraction");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueBooking.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();

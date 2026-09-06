// GST-FIRST (wizard2) — payments fill the taxed stream first, and each
// payment produces up to two invoices covering exactly what arrived.
// Run: DATABASE_URL=... node tests/venue-gst-first.test.js
//
// The founder's ruling, pinned case by case ON THE REAL ENDPOINTS (confirm →
// recordPayment → createLeadInvoice → read the stored invoices back):
//   · TAXED stream = each line's taxable base PLUS its GST; UNTAXED = the
//     rest, deposits included; they sum to the collectable.
//   · A payment UNDER the stream issues a PART tax invoice, grossed down
//     (Rs. 5,000 @18 → taxable 4,237 + GST 763). No ordinary invoice.
//   · The payment that CLOSES the stream reconciles by subtraction, so the
//     stream's tax invoices sum EXACTLY to the lines' taxable and GST.
//   · A payment OVER the stream splits: one tax invoice, one ordinary
//     invoice, the two summing to the payment to the rupee.
//   · Once the stream is closed, every later payment is untaxed — ordinary
//     invoice only, no GSTIN treatment anywhere on it.
//   · No taxable lines → never a tax invoice; entirely taxable → never an
//     ordinary one. ONE rule, no special-casing.
//   · The old model is untouched: a pre-GST-first booking's payment invoice
//     still goes down the single-invoice road, stream null.
// S3 is stubbed BEFORE the controller loads — no external writes; the PDF is
// still really rendered (the docsystem runs), only storage is faked.
require("dotenv").config();
const mongoose = require("mongoose");

// stub storage before anything destructures it
const s3 = require("../utils/s3Upload");
s3.uploadBufferToS3 = async () => "http://localhost/test-artifacts/fake.pdf";

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueCounter = require("../models/VenueCounter");

const quotes = require("../controllers/venueQuote");
const bookings = require("../controllers/venueBooking");
const payments = require("../controllers/venueLeadPayment");
const invoices = require("../controllers/venueLeadInvoice");
const { migrate } = require("../scripts/migrate-invoice-stream-index");

const TAG = `gstf-${Date.now()}`;
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

let dayCursor = 1;
const nextDate = () => `2096-0${Math.ceil(dayCursor / 28)}-${String(((dayCursor++ - 1) % 28) + 1).padStart(2, "0")}`;
const fn = (date) => [{ date, name: "Wedding", space: String(venue.spaces[0]._id) }];

/** Line quote saved on the lead, then confirmed GST-first with this schedule. */
async function bookLead(lineItems, schedule, { gstPercent = 18, tokenAmount } = {}) {
  const lead = await mkLead();
  let r = await call(quotes.createQuote, req({ body: { enquiry: String(lead._id), gstPercent, lineItems } }));
  if (r.code !== 201) throw new Error(`quote refused: ${JSON.stringify(r.body)}`);
  r = await call(bookings.confirmBookingFromLead, req({
    params: { enquiryId: String(lead._id) },
    body: { functions: fn(nextDate()), quoteId: String(r.body.quote._id), tokenAmount, paymentSchedule: schedule },
  }));
  if (r.code !== 200) throw new Error(`confirm refused: ${JSON.stringify(r.body)}`);
  return { lead, bookingId: r.body.booking._id };
}

/** Record an owner payment (auto-approved) and return its paymentId.
 *  recordPayment returns the schedule, not the id — read the newest paymentId
 *  off the booking, exactly as the Payments tab does via the listing. */
async function pay(lead, amount) {
  const r = await call(payments.recordPayment, req({ params: { enquiryId: String(lead._id) }, body: { amount, mode: "upi" } }));
  if (r.code !== 200 && r.code !== 201) throw new Error(`payment refused: ${JSON.stringify(r.body)}`);
  const bk = await VenueBooking.findOne({ enquiry: lead._id }).lean();
  const ids = [];
  for (const row of bk.paymentSchedule || []) for (const e of row.entries || []) if (e.paymentId) ids.push(String(e.paymentId));
  ids.sort();
  return ids[ids.length - 1];
}

const raise = (lead, paymentId) =>
  call(invoices.createLeadInvoice, req({ params: { enquiryId: String(lead._id) }, body: { gst: false, paymentId: String(paymentId) } }));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueInvoice.init(); // the four-key unique index must exist for the guarantees below
    // the migration is REQUIRED here so it cannot rot: drops the old
    // three-key index if a previous run left it, keeps the new one
    await migrate({ apply: true, connected: true });

    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`, spaces: [{ name: "Hall", isBookable: true }],
      gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F",
    });
    created.venues.push(venue._id);
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ══ A. ROHAAN'S EXACT EXAMPLE — under, then exactly at, then past ═══════
    console.log("\n[A. Rs. 1,00,000 rental with Rs. 10,000 taxable + Rs. 10,000 deposit — taxed 11,800, untaxed 1,00,000]");
    const A = await bookLead(
      [
        { label: "Venue rental", amount: 100000, gstTreatment: "part", taxableAmount: 10000 },
        { label: "Security deposit", amount: 10000, gstTreatment: "none", refundable: true },
      ],
      // collectable 1,11,800 — the schedule is set on the WHOLE of it
      [
        { label: "Instalment 1", amount: 5000 },
        { label: "Instalment 2", amount: 6800 },
        { label: "Instalment 3", amount: 50000 },
        { label: "Instalment 4", amount: 50000 },
      ]
    );
    const bkA = await VenueBooking.findById(A.bookingId).lean();
    ok(bkA.scheduleIncludesGst === true, "the booking carries the GST-first marker");
    eq(bkA.paymentSchedule.reduce((s2, r) => s2 + r.amount, 0), 111800,
      "🔴 the ONE schedule totals the collectable — streams are an invoicing concern, not a second schedule");

    // P1 — UNDER the taxed stream
    const p1 = await pay(A.lead, 5000);
    let r = await raise(A.lead, p1);
    eq(r.code, 201, "🔴 payment UNDER the stream: invoicing succeeds");
    ok(!r.body.secondInvoice, "…ONE invoice only — nothing landed untaxed");
    eq(r.body.invoice.stream, "taxed", "…and it is the TAX invoice");
    eq(r.body.invoice.totals.taxable, 4237, "🔴 taxable grossed down: Rs. 4,237");
    eq(r.body.invoice.totals.gst, 763, "🔴 GST Rs. 763 — taxable + GST = the Rs. 5,000 that arrived");
    eq(r.body.invoice.totals.grandTotal, 5000, "…the invoice covers exactly what arrived");
    eq(r.body.split.taxedStream, 11800, "…the stream is stated: 11,800");

    // P2 — closes the stream EXACTLY; reconciliation by subtraction
    const p2 = await pay(A.lead, 6800);
    r = await raise(A.lead, p2);
    eq(r.code, 201, "payment AT the remaining stream: invoicing succeeds");
    ok(!r.body.secondInvoice, "…still one invoice — the stream absorbed all of it");
    eq(r.body.invoice.totals.grandTotal, 6800, "…covering the Rs. 6,800");
    eq(r.body.invoice.totals.taxable, 5763, "🔴 CLOSING RECONCILIATION: taxable 5,763 by subtraction (naive rounding says 5,764)");
    eq(r.body.invoice.totals.gst, 1037, "…GST 1,037");
    ok(r.body.split.streamClosed === true, "…and the split says the stream closed");
    // the stream's documents sum EXACTLY to the lines' facts
    let taxInvs = await VenueInvoice.find({ enquiry: A.lead._id, stream: "taxed" }).lean();
    eq(taxInvs.reduce((s2, i) => s2 + i.totals.taxable, 0), 10000, "🔴 Σ taxable across the stream's invoices = the lines' 10,000, not a rupee off");
    eq(taxInvs.reduce((s2, i) => s2 + i.totals.gst, 0), 1800, "🔴 Σ GST = the lines' 1,800");

    // P3 — stream closed, paid again: ordinary only
    const p3 = await pay(A.lead, 50000);
    r = await raise(A.lead, p3);
    eq(r.code, 201, "stream closed, paid again: invoicing succeeds");
    ok(!r.body.secondInvoice, "…one invoice");
    eq(r.body.invoice.stream, "untaxed", "🔴 …and it is ORDINARY — once the stream is cleared, every later payment is untaxed");
    eq(r.body.invoice.gstMode, "none", "…gstMode none");
    eq(r.body.invoice.totals.gst, 0, "…zero GST");
    eq(r.body.invoice.totals.grandTotal, 50000, "…covering the Rs. 50,000");

    // duplicate: raising P1 again names the standing document
    r = await raise(A.lead, p1);
    eq(r.code, 409, "raising the same payment again is refused");
    eq(r.body.code, "invoice_exists", "…as invoice_exists");

    // ══ B. OVER the stream — the split, two invoices, one payment ═══════════
    console.log("\n[B. a Rs. 50,000 payment against a fresh 11,800 stream → tax 11,800 + ordinary 38,200]");
    const B = await bookLead(
      [
        { label: "Venue rental", amount: 100000, gstTreatment: "part", taxableAmount: 10000 },
        { label: "Security deposit", amount: 10000, gstTreatment: "none", refundable: true },
      ],
      [{ label: "Instalment 1", amount: 50000 }, { label: "Instalment 2", amount: 61800 }]
    );
    const pB = await pay(B.lead, 50000);
    r = await raise(B.lead, pB);
    eq(r.code, 201, "🔴 payment OVER the stream: invoicing succeeds");
    ok(Boolean(r.body.secondInvoice), "🔴 TWO invoices — a tax invoice and an ordinary invoice");
    eq(r.body.invoice.stream, "taxed", "…the first is the tax invoice");
    eq(r.body.invoice.totals.grandTotal, 11800, "🔴 …for the whole stream: 11,800");
    eq(r.body.invoice.totals.taxable, 10000, "…taxable 10,000 (closing reconciliation)");
    eq(r.body.invoice.totals.gst, 1800, "…GST 1,800");
    eq(r.body.secondInvoice.stream, "untaxed", "…the second is ordinary");
    eq(r.body.secondInvoice.totals.grandTotal, 38200, "🔴 …for the rest: 38,200");
    eq(r.body.invoice.totals.grandTotal + r.body.secondInvoice.totals.grandTotal, 50000,
      "🔴 THE TWO INVOICES SUM TO THE PAYMENT EXACTLY");
    ok(r.body.invoice.invoiceNumber !== r.body.secondInvoice.invoiceNumber,
      "…two documents, two numbers from the one gapless allocator");
    // read back: GSTIN treatment on each stored document
    const invB1 = await VenueInvoice.findById(r.body.invoice._id).lean();
    const invB2 = await VenueInvoice.findById(r.body.secondInvoice._id).lean();
    eq(invB1.gstMode, "exclusive", "stored tax invoice: gstMode exclusive");
    eq(invB1.gstPercent, 18, "…at the booking's one rate");
    eq(invB2.gstMode, "none", "stored ordinary invoice: gstMode none — no tax treatment anywhere");
    eq(invB2.gstPercent, 0, "…rate 0");
    ok(invB1.lineItems[0].taxable === 10000 && invB1.lineItems[0].gst === 1800,
      "…the tax invoice's line carries its own taxable/GST facts for the CGST/SGST columns");
    ok(invB2.lineItems[0].taxable === 0 && invB2.lineItems[0].gst === 0,
      "…the ordinary invoice's line carries none");
    // both filed in the Documents tab
    const docsB = await VenueLeadDocument.countDocuments({ enquiry: B.lead._id, kind: "invoice" });
    eq(docsB, 2, "…and both PDFs are filed as lead documents");

    // ══ C. NO TAXABLE LINES — never a tax invoice ═══════════════════════════
    console.log("\n[C. a quote with no taxable lines at all]");
    const C = await bookLead(
      [
        { label: "Venue rental", amount: 80000, gstTreatment: "none" },
        { label: "Security deposit", amount: 5000, gstTreatment: "none", refundable: true },
      ],
      [{ label: "Instalment 1", amount: 85000 }]
    );
    const pC = await pay(C.lead, 85000);
    r = await raise(C.lead, pC);
    eq(r.code, 201, "invoicing succeeds");
    ok(!r.body.secondInvoice, "one invoice");
    eq(r.body.invoice.stream, "untaxed", "🔴 no taxable lines → ordinary invoice, no tax invoice ever");
    eq(r.body.split.taxedStream, 0, "…the taxed stream is zero");

    // ══ D. ENTIRELY TAXABLE — never an ordinary invoice ═════════════════════
    console.log("\n[D. a quote entirely taxable]");
    const D = await bookLead(
      [{ label: "Venue rental", amount: 100000, gstTreatment: "full" }],
      [{ label: "Instalment 1", amount: 70000 }, { label: "Instalment 2", amount: 48000 }]
    );
    const pD1 = await pay(D.lead, 70000);
    r = await raise(D.lead, pD1);
    eq(r.code, 201, "invoicing succeeds");
    ok(!r.body.secondInvoice && r.body.invoice.stream === "taxed",
      "🔴 entirely taxable → tax invoice only, part of the stream");
    eq(r.body.invoice.totals.taxable, 59322, "…taxable 59,322 grossed down from 70,000 @18");
    const pD2 = await pay(D.lead, 48000);
    r = await raise(D.lead, pD2);
    ok(!r.body.secondInvoice && r.body.invoice.stream === "taxed", "…and the closer is a tax invoice too");
    taxInvs = await VenueInvoice.find({ enquiry: D.lead._id, stream: "taxed" }).lean();
    eq(taxInvs.reduce((s2, i) => s2 + i.totals.taxable, 0), 100000, "🔴 Σ taxable = the full 1,00,000");
    eq(taxInvs.reduce((s2, i) => s2 + i.totals.gst, 0), 18000, "🔴 Σ GST = the full 18,000");

    // ══ E. NO GSTIN — the taxed stream refuses, the untaxed does not ════════
    console.log("\n[E. venue without a GSTIN]");
    const noGstinVenue = await Venue.create({ name: `${TAG}-ng`, slug: `${TAG}-ng`, spaces: [{ name: "Hall", isBookable: true }] });
    created.venues.push(noGstinVenue._id);
    const savedVenue = venue; venue = noGstinVenue;
    const ngOwner = await VenueOwner.create({ venueId: noGstinVenue._id, name: "O2", phone: `${TAG}n`.slice(0, 14), isActive: true });
    const savedOwner = owner; owner = ngOwner;
    const E = await bookLead(
      [{ label: "Venue rental", amount: 10000, gstTreatment: "full" }],
      [{ label: "Instalment 1", amount: 11800 }]
    );
    const pE = await pay(E.lead, 5000);
    r = await raise(E.lead, pE);
    eq(r.code, 400, "a taxed-stream payment without a venue GSTIN is refused");
    eq(r.body.code, "no_gstin", "…as no_gstin — the tax invoice must carry the venue's GSTIN, always");
    venue = savedVenue; owner = savedOwner;

    // ══ F. THE OLD MODEL IS UNTOUCHED ═══════════════════════════════════════
    console.log("\n[F. a pre-GST-first booking still gets the single-invoice road]");
    const oldLead = await mkLead();
    r = await call(bookings.confirmBookingFromLead, req({
      params: { enquiryId: String(oldLead._id) },
      body: { functions: fn(nextDate()), totalValue: 50000, paymentSchedule: [{ label: "Full", amount: 50000 }] },
    }));
    eq(r.code, 200, "a legacy (no-lines) booking confirms as ever");
    const bkOld = await VenueBooking.findOne({ enquiry: oldLead._id }).lean();
    ok(!bkOld.scheduleIncludesGst, "…and does NOT carry the GST-first marker");
    const pOld = await pay(oldLead, 20000);
    r = await raise(oldLead, pOld);
    eq(r.code, 201, "its payment invoice raises down the old road");
    ok(!r.body.secondInvoice, "…one invoice, as before");
    const invOld = await VenueInvoice.findById(r.body.invoice._id).lean();
    ok(!invOld.stream, "🔴 …with stream null — the old model is byte-for-byte untouched");

    // ══ I. WHAT THE COUPLE OWES INCLUDES THE GST (payments summary) ═════════
    console.log("\n[I. the payments summary owes the collectable, not the ex-GST value]");
    r = await call(payments.getLeadPayments, req({ params: { enquiryId: String(A.lead._id) } }));
    eq(r.body.totals.total, 111800, "🔴 total owed = charged + held + GST — the schedule matches it");
    eq(r.body.totals.gst, 1800, "…with the GST stated as its own figure");
    ok(r.body.totals.scheduleMatchesValue === true,
      "🔴 the 'schedule does not add up' warning is GONE for a GST-first booking (drive finding)");
    eq(r.body.totals.charged, 100000, "…while charged (revenue) stays ex-GST, ex-deposit");

    // ══ H. THE TOKEN IS THE FIRST PAYMENT — invoiceable, stream-first ═══════
    console.log("\n[H. the token consumes the taxed stream first and carries its own tax invoice]");
    const H = await bookLead(
      [{ label: "Venue rental", amount: 10000, gstTreatment: "full" }],
      [{ label: "Instalment 1", amount: 7800 }],
      { tokenAmount: 4000 }
    );
    const bkH = await VenueBooking.findById(H.bookingId).lean();
    const tokenRowH = bkH.paymentSchedule.find((row) => /token/i.test(row.label || ""));
    ok(tokenRowH && tokenRowH.entries[0] && tokenRowH.entries[0].paymentId,
      "🔴 the confirm-built token entry carries a paymentId — it is a payment, so it is invoiceable (drive finding)");
    r = await raise(H.lead, tokenRowH.entries[0].paymentId);
    eq(r.code, 201, "raising the TOKEN's invoice succeeds");
    ok(!r.body.secondInvoice && r.body.invoice.stream === "taxed", "…a tax invoice — the token fills the taxed stream first");
    eq(r.body.invoice.totals.grandTotal, 4000, "…covering the token exactly");
    eq(r.body.invoice.totals.taxable, 3390, "…taxable 3,390 grossed down @18");
    const pH = await pay(H.lead, 7800);
    r = await raise(H.lead, pH);
    eq(r.code, 201, "the closing payment invoices");
    eq(r.body.invoice.totals.taxable, 6610, "🔴 closing reconciliation continues FROM the token's invoice: 10,000 − 3,390");
    eq(r.body.invoice.totals.gst, 1190, "…GST 1,190");
    const tiH = await VenueInvoice.find({ enquiry: H.lead._id, stream: "taxed" }).lean();
    eq(tiH.reduce((s2, i) => s2 + i.totals.taxable, 0), 10000, "🔴 token + payment invoices sum to the lines' full taxable");
    eq(tiH.reduce((s2, i) => s2 + i.totals.gst, 0), 1800, "…and the full GST");

    // ══ G. THE INDEX GUARANTEE ══════════════════════════════════════════════
    console.log("\n[G. one payment, one invoice per stream — the database says so]");
    const dupe = new VenueInvoice({
      venue: venue._id, booking: A.bookingId, enquiry: A.lead._id,
      invoiceNumber: `${TAG}-DUP`, seq: 99999, forPaymentId: p1, stream: "taxed",
      lineItems: [], totals: { subtotal: 1, taxable: 1, gst: 0, grandTotal: 1 },
    });
    let threw = null;
    try { await dupe.save(); } catch (e) { threw = e; }
    ok(threw && threw.code === 11000, "🔴 a second taxed invoice for the same payment is refused by the unique index itself");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("SUITE ERROR:", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueInvoice.deleteMany({ venue: v });
      await VenueLeadDocument.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueQuote.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueOwner.deleteMany({ venueId: v });
      await VenueCounter.deleteMany({ key: new RegExp(`^${v}:`) });
      await Venue.deleteOne({ _id: v });
    }
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

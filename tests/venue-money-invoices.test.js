// MONEY LINES S5 — invoices built from lines; held money never on a tax invoice.
// Run: DATABASE_URL=... node tests/venue-money-invoices.test.js
//
// The load-bearing claims:
//   · The three fake-single-line fabrications bill the booking's REAL lines.
//   · A HELD DEPOSIT IS NOT ON A TAX INVOICE. The model already refuses to
//     invoice held money (the room-stay deposit invoices only its materialised
//     deduction — controllers/venueCheckin); the booking-level, venue-level and
//     bill fabrications all follow it.
//   · GST derives PER LINE into finished totals — computeTotals' one rate on
//     one subtotal would over-tax "part" and "none" lines — and the AGREEMENT
//     decides: the owner's gst checkbox is ignored on a line booking.
//   · KNOWN GAP, pinned: a payment landing on the deposit row still raises a
//     numbered invoice billing held money. Awaiting the founder's ruling on
//     what document accompanies a deposit payment; recorded, not endorsed.
require("dotenv").config();
const mongoose = require("mongoose");

// S3 is stubbed at the module boundary so the suite never writes objects.
const s3 = require("../utils/s3Upload");
const uploaded = [];
s3.uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  uploaded.push({ key, bytes: buffer.length, contentType });
  return `https://stub.local/${key}`;
};

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueInvoice = require("../models/VenueInvoice");
const VenueBill = require("../models/VenueBill");
const VenueLeadDocument = require("../models/VenueLeadDocument");

const leadInv = require("../controllers/venueLeadInvoice");
const inv = require("../controllers/venueInvoice");
const docs = require("../controllers/venueDocs");
const { buildInvoicePdf } = require("../utils/venueInvoicePdf");

const TAG = `minv-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

/** PDF text: decode the hex TJ runs (compress:false), compare space-stripped. */
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
  { label: "Decor package", amount: 200000, gstTreatment: "part", taxableAmount: 50000, refundable: false },
  { label: "Security deposit", amount: 25000, gstTreatment: "none", taxableAmount: 0, refundable: true, source: { chargeKey: "security_deposit" } },
];
const PAYMENT_ID = new mongoose.Types.ObjectId();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueInvoice.init();
    await VenueLeadDocument.init();

    venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      gstin: "29ABCDE1234F1Z5", invoicePrefix: "ML-",
    });
    created.venues.push(venue._id);
    const mkLead = () => VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`, stage: "booked",
    });
    const lead = await mkLead();
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: `${TAG} A`, totalValue: 700000,
      lineItems: LINES, gstMode: "none", gstPercent: 18,
      days: [{ date: new Date(Date.now() + 30 * 86400000), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [
        { label: "Security deposit", amount: 25000, entries: [{ paymentId: PAYMENT_ID, amount: 25000, status: "approved" }] },
        { label: "Balance", amount: 700000 },
      ],
    });

    // ══ A. THE BOOKING-LEVEL LEAD INVOICE ═══════════════════════════════════
    console.log("\n[A. the lead invoice bills the lines — the deposit is not on it]");
    // The owner's checkbox says NO GST; the agreement says the lines bear it.
    let r = await call(leadInv.createLeadInvoice, req({ params: { enquiryId: String(lead._id) }, body: { gst: false } }));
    eq(r.code, 201, "the booking-level invoice files");
    const invoiceA = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId: null, forPaymentId: null }).lean();
    eq(invoiceA.lineItems.length, 2, "🔴 two lines — the booking's real lines, not one fabricated 'Venue booking'");
    ok(!invoiceA.lineItems.some((li) => /deposit/i.test(li.label)),
      "🔴 THE HELD DEPOSIT IS NOT ON THE TAX INVOICE — held money is not a supply");
    eq(invoiceA.totals.subtotal, 700000, "subtotal is the charged figure");
    eq(invoiceA.totals.taxable, 550000, "taxable = full's amount + part's taxableAmount");
    eq(invoiceA.totals.gst, 99000, "🔴 GST derives PER LINE (90,000 + 9,000) — one rate on the subtotal would say 1,26,000");
    eq(invoiceA.totals.grandTotal, 799000, "grand total = charged + line GST");
    eq(invoiceA.gstMode, "exclusive", "stored exclusive — base + GST is that shape");
    eq(invoiceA.gstPercent, 18, "…at the one rate");
    // The PDF a couple could dispute, asserted on rendered bytes.
    const pdfA = (await buildInvoicePdf({ venue: venue.toObject(), booking: booking.toObject(), invoice: invoiceA })).buffer;
    ok(pdfA.slice(0, 5).toString() === "%PDF-", "a real PDF came back");
    ok(has(pdfA, "Tax Invoice"), "the header says Tax Invoice (GST borne)");
    ok(has(pdfA, "Venue hire") && has(pdfA, "Decor package"), "…the lines are on the page");
    ok(!has(pdfA, "Security deposit"), "🔴 …and the deposit is nowhere on it");
    ok(has(pdfA, "GST @ 18%"), "…GST stated at the rate");

    // ══ B. THE VENUE-LEVEL INVOICE AND THE BILL ═════════════════════════════
    console.log("\n[B. createFromBooking and the bill fabricate from the same lines]");
    r = await call(inv.createFromBooking, req({ body: { booking: String(booking._id), kind: "final" } }));
    eq(r.code, 201, "venue-level invoice files");
    eq(r.body.invoice.lineItems.length, 2, "…from the booking's lines");
    ok(!r.body.invoice.lineItems.some((li) => /deposit/i.test(li.label)), "🔴 no deposit here either");
    eq(r.body.invoice.totals.gst, 99000, "…same per-line GST");

    r = await call(docs.createBill, req({ body: { booking: String(booking._id) } }));
    eq(r.code, 201, "a bill seeds from the booking");
    eq(r.body.bill.lineItems.length, 2, "…with the two charged lines");
    ok(!r.body.bill.lineItems.some((li) => /deposit/i.test(li.label)), "🔴 and no deposit on the bill");
    eq(r.body.bill.gstMode, "none",
      "MIXED treatments cannot be one rate on one subtotal — the bill seeds mode none (under-states, never over-charges); the invoice is the exact tax document");

    // An ALL-FULL booking's bill CAN be exact: exclusive at the rate.
    const lead2 = await mkLead();
    const bookingFull = await VenueBooking.create({
      venue: venue._id, enquiry: lead2._id, coupleName: `${TAG} F`, totalValue: 300000,
      lineItems: [{ label: "Venue hire", amount: 300000, gstTreatment: "full", refundable: false }],
      gstMode: "none", gstPercent: 18,
      paymentSchedule: [{ label: "Full", amount: 300000 }],
    });
    r = await call(docs.createBill, req({ body: { booking: String(bookingFull._id) } }));
    eq(r.body.bill.gstMode, "exclusive", "all-full lines → the bill's one-rate math is exact: exclusive");
    eq(r.body.bill.totals.gst, 54000, "…and computes the same 18%");

    // ══ C. THE AGREEMENT DECIDES, AND THE GSTIN GUARD HOLDS ═════════════════
    console.log("\n[C. owner's checkbox ignored; no GSTIN refuses]");
    ok(invoiceA.totals.gst === 99000, "🔴 body.gst:false did NOT strip the tax — the agreement decides, not the checkbox (section A filed with gst:false)");
    const bareVenue = await Venue.create({ name: `${TAG} Bare`, slug: `${TAG}-bare`, city: "B", state: "K" });
    created.venues.push(bareVenue._id);
    const bareLead = await VenueEnquiry.create({ venueId: bareVenue._id, coupleName: "Bare", couplePhone: `8${Math.floor(Math.random() * 1e9)}`, stage: "booked" });
    await VenueBooking.create({
      venue: bareVenue._id, enquiry: bareLead._id, coupleName: "Bare", totalValue: 100000,
      lineItems: [{ label: "Venue hire", amount: 100000, gstTreatment: "full", refundable: false }],
      gstMode: "none", gstPercent: 18, paymentSchedule: [{ label: "Full", amount: 100000 }],
    });
    r = await call(leadInv.createLeadInvoice, {
      params: { slug: bareVenue.slug, enquiryId: String(bareLead._id) }, query: {}, body: {},
      venueOwner: { type: "venue_owner", venueId: bareVenue._id, venueOwnerId: new mongoose.Types.ObjectId() }, venueMember: null,
    });
    eq(r.code, 400, "lines bear GST + no GSTIN → refused");
    eq(r.body.code, "no_gstin", "…with the standing code");

    // A booking whose lines bear NO GST invoices as a plain Invoice.
    const lead3 = await mkLead();
    const bookingNone = await VenueBooking.create({
      venue: venue._id, enquiry: lead3._id, coupleName: `${TAG} N`, totalValue: 200000,
      lineItems: [{ label: "Venue hire", amount: 200000, gstTreatment: "none", refundable: false }],
      gstMode: "none", gstPercent: 18, paymentSchedule: [{ label: "Full", amount: 200000 }],
    });
    r = await call(leadInv.createLeadInvoice, req({ params: { enquiryId: String(lead3._id) }, body: { gst: true } }));
    eq(r.code, 201, "no-GST lines invoice fine");
    const invN = await VenueInvoice.findOne({ enquiry: lead3._id }).lean();
    eq(invN.gstMode, "none", "🔴 …and body.gst:true cannot conjure tax the agreement never carried");
    eq(invN.totals.gst, 0, "…zero GST");

    // ══ D. KNOWN GAP, PINNED — the deposit-row payment invoice ══════════════
    console.log("\n[D. KNOWN GAP: a payment on the deposit row still raises an invoice for held money]");
    // RECORDED, NOT ENDORSED. What accompanies a deposit payment is an open
    // ruling (a receipt? a refusal? an invoice marked held?) entangled with
    // the un-ruled per-instalment GST question for line bookings. This pin
    // keeps the behaviour visible so changing it is a decision, not a drift.
    r = await call(leadInv.createLeadInvoice, req({ params: { enquiryId: String(lead._id) }, body: { paymentId: String(PAYMENT_ID) } }));
    eq(r.code, 201, "🔴 KNOWN GAP (recorded, not endorsed): the deposit payment raises a numbered invoice");
    const invD = await VenueInvoice.findOne({ enquiry: lead._id, forPaymentId: PAYMENT_ID }).lean();
    ok(invD.lineItems.some((li) => /Security deposit/.test(li.label)),
      "…billing the held 25,000 as a line — the document a CA would query, awaiting the founder's ruling");
    eq(invD.gstMode, "none", "…at least without GST: the line booking's gstMode none means gstOnRow bears nothing");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueInvoice.deleteMany({ venue: { $in: created.venues } });
      await VenueBill.deleteMany({ venue: { $in: created.venues } });
      await VenueLeadDocument.deleteMany({ venue: { $in: created.venues } });
      await VenueBooking.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();

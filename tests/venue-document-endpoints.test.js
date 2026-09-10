// EVERY DOCUMENT, THROUGH ITS REAL ENDPOINT, BYTES OPENED.
// Run: DATABASE_URL=... node tests/venue-document-endpoints.test.js
//
// QUOTEWIRE's lesson: the old generator survived b5a24f1's sweep because the
// sweep converted the design's enumeration ("the five documents"), not the
// code's reality — and NO TEST OPENED THE BYTES through an endpoint, so
// neither suite could see which renderer ran. This one can: each document is
// produced through its real controller door and the produced PDF is decoded.
// The DOCUMENT SYSTEM's signature is the parties block ("THE VENUE") — the
// old generator has no such block — plus each document's fixed wording.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const s3 = require("../utils/s3Upload");
const { pdfFlat, normalise } = require("./docsystem-helpers");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const has = (flat, probe, label) => ok(normalise(flat).includes(normalise(probe)), `${label} [${probe.slice(0, 44)}]`);
const TAG = `docend-${Date.now()}`;

// capture every uploaded artefact's BYTES, not just its key
const uploads = [];
const realUpload = s3.uploadBufferToS3;
s3.uploadBufferToS3 = async ({ buffer, key }) => { uploads.push({ key, buffer }); return `https://bucket.test/${key}`; };

const mockRes = () => ({
  code: 200, body: null, sent: null, headers: {},
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k] = v; },
  send(b) { this.sent = b; return this; },
  end(b) { this.sent = b; return this; },
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const lastUpload = () => uploads[uploads.length - 1];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const ownerId = new mongoose.Types.ObjectId();
    const venue = await Venue.create({
      name: `${TAG} Estate`, slug: `${TAG}-v`, address: "41 Hill Road, Bengaluru 560001",
      gstin: "29AAGCA4821K1ZP", pan: "AAGCA4821K",
      contact: { primaryPhone: "+91 80 1111 2222", email: "ops@estate.in" },
    });
    const req = (extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, body: extra.body || {}, query: extra.query || {}, venueOwner: { venueOwnerId: ownerId, venueId: venue._id } });

    // ══ 1. THE QUOTE, filed through the CRM door — line AND legacy ══════════
    console.log("[1. quote via storeQuoteDocument — the switched door]");
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Ananya & Karthik", couplePhone: "9800112233", stage: "proposal_sent",
      contacts: [{ name: "Ananya Rao", phone: "9800112233", isPrimary: true }],
    });
    const lineQuote = await VenueQuote.create({
      venue: venue._id, enquiry: lead._id, version: 1, status: "sent", gstPercent: 18,
      lineItems: [
        { label: "Venue rental", qty: 1, unitPrice: 500000, amount: 500000, gstTreatment: "full", taxableAmount: 0 },
        { label: "Cleaning", qty: 1, unitPrice: 20000, amount: 20000, gstTreatment: "none", taxableAmount: 0 },
      ],
      totals: { subtotal: 520000, taxable: 500000, gst: 90000, grandTotal: 610000, charged: 520000, refundable: 0 },
      terms: ["50% on booking, balance 30 days before the event.", "Outside caterers need prior approval."],
      whiteLabel: false,
    });
    const send = require("../controllers/venueDocumentSend");
    const r1 = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(lineQuote._id) } }));
    ok(r1.code === 201, `line quote filed (${r1.code})`);
    const lineFlat = pdfFlat(lastUpload().buffer);
    has(lineFlat, "THE VENUE", "🔴 the bytes are DOCUMENT-SYSTEM output — the parties block exists");
    has(lineFlat, "Total payable", "…with the fixed wording");
    has(lineFlat, "Rs. 5,20,000", "…and the line quote's real figures");
    has(lineFlat, "Terms & conditions", "loss #1: the venue's own terms print");
    has(lineFlat, "Outside caterers need prior approval.", "…verbatim");
    has(lineFlat, "POWERED BY WEDSY", "non-white-label: the mark prints");

    // the LEGACY quote — the blocker: real figures, never zero
    const legacyQuote = await VenueQuote.create({
      venue: venue._id, enquiry: lead._id, version: 2, status: "sent",
      gstPercent: 18, gstMode: "exclusive", discount: 15000, whiteLabel: true,
      lineItems: [
        { label: "Lawn hire", qty: 2, unitPrice: 150000, day: 1, amount: null, gstTreatment: "" },
        { label: "Rooms block", qty: 10, unitPrice: 8000, amount: null, gstTreatment: "" },
      ],
      totals: { subtotal: 380000, taxable: 365000, gst: 65700, grandTotal: 430700 },
      acceptance: { name: "Ananya Rao", phone: "9800112233", at: new Date("2026-09-01"), channel: "link" },
    });
    const r2 = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(legacyQuote._id) } }));
    ok(r2.code === 201, `legacy quote filed (${r2.code})`);
    const legFlat = pdfFlat(lastUpload().buffer);
    has(legFlat, "THE VENUE", "legacy: document-system bytes");
    has(legFlat, "3,00,000", "🔴 THE BLOCKER: qty × unit prints REAL figures — 2 × 1,50,000, never zero");
    has(legFlat, "2 × Rs. 1,50,000", "…the composition (Day/Qty/Unit) survives as the sub-line");
    has(legFlat, "Rs. 3,80,000", "…the stored subtotal is the charged figure");
    ok(/[−\\x96-]\s*Rs\.\s*15,000|− Rs\. 15,000/.test(normalise(legFlat)) || normalise(legFlat).includes("15,000"), "loss #4: the discount row prints");
    has(legFlat, "Rs. 4,30,700", "…and the stored grand total is the collectable");
    has(legFlat, "Accepted by Ananya Rao on 1 September 2026 via link (phone verified).", "loss #2: the acceptance evidence, verbatim");
    ok(!normalise(legFlat).includes("POWERED BY WEDSY"), "loss #3: white-label drops Wedsy's mark");
    ok(!/Rs\. 0\b/.test(legFlat), "…and no zero-rupee figure anywhere");

    // ══ 2. THE CONFIRMATION through its endpoint ════════════════════════════
    console.log("\n[2. confirmation via generateBookingConfirmation]");
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Ananya & Karthik", status: "confirmed",
      gstPercent: 18, gstMode: "none", totalValue: 520000, scheduleIncludesGst: true,
      checkIn: new Date("2026-11-21T06:00:00+05:30"), checkOut: new Date("2026-11-22T14:00:00+05:30"),
      days: [{ date: new Date("2026-11-21"), eventType: "Wedding", guestCount: 300, spaces: ["Grand Lawn"] }],
      lineItems: [
        { label: "Venue rental", amount: 500000, gstTreatment: "full", taxableAmount: 0, refundable: false },
        { label: "Cleaning", amount: 20000, gstTreatment: "none", taxableAmount: 0, refundable: false },
      ],
      paymentSchedule: [
        { label: "Token — received", amount: 200000, dueDate: new Date("2026-09-01"),
          entries: [{ amount: 200000, date: new Date("2026-09-01"), method: "upi", reference: "UTR-9", status: "approved", paymentId: new mongoose.Types.ObjectId(), approvedAt: new Date() }] },
        { label: "Balance", amount: 410000, dueDate: new Date("2026-11-07"), entries: [] },
      ],
    });
    const bc = require("../controllers/venueBookingConfirmation");
    const r3 = await call(bc.generateBookingConfirmation, req({ params: { enquiryId: String(lead._id) }, body: {} }));
    ok(r3.code === 201, `confirmation generated (${r3.code})`);
    const confFlat = pdfFlat(lastUpload().buffer);
    has(confFlat, "THE VENUE", "confirmation bytes are document-system output");
    has(confFlat, "Booking confirmation", "…titled by the system");

    // ══ 3. THE INVOICE through createLeadInvoice ════════════════════════════
    console.log("\n[3. invoice via createLeadInvoice]");
    const li = require("../controllers/venueLeadInvoice");
    const r4 = await call(li.createLeadInvoice, req({ params: { enquiryId: String(lead._id) }, body: { milestoneId: String(booking.paymentSchedule[1]._id) } }));
    ok([200, 201].includes(r4.code), `invoice raised (${r4.code})`);
    const invFlat = pdfFlat(lastUpload().buffer);
    has(invFlat, "THE VENUE", "invoice bytes are document-system output");
    has(invFlat, "Venue & event services", "…with the system's supply fact");

    // ══ 4. THE STATEMENT through its endpoint ═══════════════════════════════
    console.log("\n[4. statement via its generate endpoint]");
    const st = require("../controllers/venueLeadStatement");
    const stFn = st.generateStatement || st.createStatement || st.generate;
    ok(typeof stFn === "function", "statement endpoint located");
    const r5 = await call(stFn, req({ params: { enquiryId: String(lead._id) }, body: {} }));
    ok([200, 201].includes(r5.code), `statement generated (${r5.code})`);
    const stFlat = pdfFlat(lastUpload().buffer);
    has(stFlat, "THE VENUE", "statement bytes are document-system output");
    has(stFlat, "How the outstanding figure is arrived at", "…with the system's closing");
    has(stFlat, "Invoices raised", "…and the invoice trail");

    // ══ 5. THE RECEIPT through its endpoint (streamed) ══════════════════════
    console.log("\n[5. receipt via its endpoint]");
    const lp = require("../controllers/venueLeadPayment");
    const rFn = lp.paymentReceiptPdf || lp.receiptPdf || lp.getReceiptPdf;
    ok(typeof rFn === "function", "receipt endpoint located");
    const payId = booking.paymentSchedule[0].entries[0].paymentId;
    const r6 = await call(rFn, req({ params: { enquiryId: String(lead._id), paymentId: String(payId) } }));
    ok(r6.code === 200 && r6.sent, `receipt streamed (${r6.code}${r6.body ? ` — ${r6.body.message}` : ""})`);
    if (!r6.sent) throw new Error("receipt gave no bytes — see the line above");
    const recFlat = pdfFlat(r6.sent);
    has(recFlat, "THE VENUE", "receipt bytes are document-system output");
    has(recFlat, "Received, with thanks", "…the system's receipt title");

    // ══ 6. THE CONVERTED LATENT DOOR ════════════════════════════════════════
    console.log("\n[6. the latent invoice route, converted]");
    const inv = await VenueInvoice.findOne({ enquiry: lead._id }).lean();
    const vi = require("../controllers/venueInvoice");
    const r7 = await call(vi.invoicePdf, req({ params: { invoiceId: String(inv._id) } }));
    ok(r7.code === 200 && r7.sent, `the old streaming route answers (${r7.code})`);
    has(pdfFlat(r7.sent), "THE VENUE", "🔴 …and its bytes are document-system output — the old generator's last live door is closed");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    s3.uploadBufferToS3 = realUpload;
    try {
      const v = await Venue.findOne({ slug: new RegExp(`^${TAG}`) }).lean();
      if (v) {
        await VenueInvoice.deleteMany({ venue: v._id });
        await VenueBooking.deleteMany({ venue: v._id });
        await VenueQuote.deleteMany({ venue: v._id });
        await VenueEnquiry.deleteMany({ venueId: v._id });
        await Venue.deleteMany({ _id: v._id });
      }
    } catch (_) { /* disposable */ }
    await mongoose.disconnect();
  }
})();

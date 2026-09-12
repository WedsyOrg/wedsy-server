// THE DOCUMENT GENERATOR — server half, proven on stored bytes.
// Run: DATABASE_URL=mongodb://127.0.0.1:27017/<db> node tests/venue-docgen.test.js
//
// The generate box's contract: one options endpoint whose refusals explain
// themselves; the quote's token stored on the quote and printed as a real
// row with a true proof; notes that live on the document, survive
// regeneration, renumber from the list, and never bring a rectangle.
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const { pdfFlat } = require("./docsystem-helpers");
const { LANGUAGE_NAMES } = require("../utils/docsystem");
const s3 = require("../utils/s3Upload");
const pdfStitch = require("../utils/pdfStitch");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const has = (flat, needle, label) => ok(flat.includes(needle), `${label} [${needle.slice(0, 44)}]`);
const hasNot = (flat, needle, label) => ok(!flat.includes(needle), label);
const TAG = `docgen-${Date.now()}`;

const uploads = [];
s3.uploadBufferToS3 = async ({ buffer, key }) => { uploads.push({ key, buffer }); return `https://bucket.test/${key}`; };
const lastUpload = () => uploads[uploads.length - 1];

const mockRes = () => ({
  code: 200, body: null, sent: null, headers: {},
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k] = v; },
  send(b) { this.sent = b; return this; },
  end(b) { this.sent = b; return this; },
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const ownerId = new mongoose.Types.ObjectId();
    const venue = await Venue.create({
      name: `${TAG} Estate`, slug: `${TAG}-v`, address: "41 Hill Road, Bengaluru 560001",
      gstin: "29AAGCA4821K1ZP", pan: "AAGCA4821K",
      contact: { primaryPhone: "+91 80 1111 2222", email: "ops@estate.in" },
    });
    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      body: extra.body || {}, query: {},
      venueOwner: { venueOwnerId: ownerId, venueId: venue._id },
    });
    const opts = require("../controllers/venueDocumentOptions");
    const send = require("../controllers/venueDocumentSend");
    const leadPayment = require("../controllers/venueLeadPayment");

    // ══ 1. THE OPTIONS ENDPOINT — refusals explain themselves ═══════════════
    console.log("[1. unavailable kinds refuse with an explanation — never hidden]");
    const bare = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Farah & Zain", couplePhone: "9810011002", stage: "new",
      contacts: [{ name: "Farah", phone: "9810011002", isPrimary: true }],
    });
    const r1 = await call(opts.documentOptions, req({ params: { enquiryId: String(bare._id) } }));
    ok(r1.code === 200, `options answered (${r1.code})`);
    const k1 = r1.body.kinds;
    ok(Object.keys(k1).length === 6, `all six kinds returned, none hidden (${Object.keys(k1).length})`);
    ok(k1.quote.available === false && /no quote yet/.test(k1.quote.reason), "quote: refused with its reason");
    ok(k1.confirmation.available === false && /No booking exists yet/.test(k1.confirmation.reason), "confirmation: refused with its reason");
    ok(k1.invoice.available === false && /cannot invoice before a booking exists/.test(k1.invoice.reason), "🔴 invoice: the ruling's own sentence");
    ok(k1.receipt.available === false && /no payment to receipt yet/.test(k1.receipt.reason), "receipt: refused with its reason");
    ok(k1.statement.available === false && /no money story yet/.test(k1.statement.reason), "statement: refused with its reason");
    ok(k1.terms.available === false && /No T&C PDF uploaded yet/.test(k1.terms.reason), "terms: refused with its reason");

    // ══ 2. THE QUOTE'S TOKEN — stored, printed, proven ══════════════════════
    console.log("\n[2. the token: a field the owner sets, a row the document proves]");
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Ananya & Karthik", couplePhone: "9800112233", stage: "proposal_sent",
      contacts: [{ name: "Ananya Rao", phone: "9800112233", isPrimary: true }],
    });
    const quote = await VenueQuote.create({
      venue: venue._id, enquiry: lead._id, version: 1, status: "sent", gstPercent: 18,
      lineItems: [
        { label: "Venue rental", qty: 1, unitPrice: 500000, amount: 500000, gstTreatment: "full", taxableAmount: 0 },
        { label: "Cleaning", qty: 1, unitPrice: 20000, amount: 20000, gstTreatment: "none", taxableAmount: 0 },
      ],
      totals: { subtotal: 520000, taxable: 500000, gst: 90000, grandTotal: 610000, charged: 520000, refundable: 0 },
    });
    // over-token refused where typed (the wizard3 rule)
    const rOver = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id), tokenAmount: 700000 } }));
    ok(rOver.code === 400 && rOver.body.code === "token_exceeds_total", `🔴 over-token refused with the reason (${rOver.code}/${rOver.body.code})`);
    // the real generation: token + validity
    const rTok = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id), tokenAmount: 100000, validUntil: "2027-01-15" } }));
    ok(rTok.code === 201, `quote generated with token (${rTok.code})`);
    const qStored = await VenueQuote.findById(quote._id).lean();
    ok(qStored.tokenAmount === 100000, `🔴 the token is STORED ON THE QUOTE — the wizard reads it from here (${qStored.tokenAmount})`);
    ok(qStored.validUntil && qStored.validUntil.toISOString().slice(0, 10) === "2027-01-15",
      "…and validUntil finally survives — the schema field that never existed");
    const fTok = pdfFlat(lastUpload().buffer);
    has(fTok, "Booking amount (token)", "the REAL row prints");
    has(fTok, "On confirmation", "…due on confirmation");
    has(fTok, "1,00,000", "…the figure the owner typed");
    has(fTok, "The balance of Rs. 5,10,000 is scheduled at confirmation", "…the balance in words");
    has(fTok, "Token and balance sum exactly to the total including GST, Rs. 6,10,000.", "🔴 the proof row returns with something true to prove");
    has(fTok, "Held until 15 January 2027", "…and the validity prints");
    hasNot(fTok, "is agreed at confirmation. The instalment plan", "…the words-only fallback is gone when a token exists");
    // exact token — legitimate, balance-zero words
    const rExact = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id), tokenAmount: 610000 } }));
    ok(rExact.code === 201, `exact token accepted (${rExact.code})`);
    has(pdfFlat(lastUpload().buffer), "The token covers the whole amount", "…and says so plainly");
    await VenueQuote.updateOne({ _id: quote._id }, { $set: { tokenAmount: 100000 } });
    // attach-terms refusal when no PDF exists
    const rAT = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id), attachTerms: true } }));
    ok(rAT.code === 400 && rAT.body.code === "no_terms_document", `attachTerms without a T&C PDF refuses with the reason (${rAT.code})`);
    // no token on a DIFFERENT quote → the honest words remain
    const quote2 = await VenueQuote.create({
      venue: venue._id, enquiry: lead._id, version: 2, status: "draft", gstPercent: 18,
      lineItems: quote.lineItems, totals: quote.totals,
    });
    const rNoTok = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote2._id) } }));
    ok(rNoTok.code === 201, `token-less quote still generates (${rNoTok.code})`);
    has(pdfFlat(lastUpload().buffer), "is agreed at confirmation", "…with the words, never an invented figure");
    // the token row in all four languages
    for (const lang of ["ledger", "stationery", "panel"]) {
      await Venue.updateOne({ _id: venue._id }, { $set: { "settings.documentLanguage": lang } });
      const rl = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id) } }));
      ok(rl.code === 201, `[${lang}] generated (${rl.code})`);
      const f = pdfFlat(lastUpload().buffer);
      ok(f.includes("Booking amount (token)") && f.includes("Token and balance sum exactly"), `[${lang}] token row + proof`);
    }
    await Venue.updateOne({ _id: venue._id }, { $unset: { "settings.documentLanguage": "" } });

    // ══ 3. NOTES — on the document, surviving, renumbering, box-free ════════
    console.log("\n[3. notes: stored as a list, numbered at render, carried forward]");
    const rN1 = await call(send.storeQuoteDocument, req({
      params: { enquiryId: String(lead._id) },
      body: { quoteId: String(quote._id), docNotes: { numbered: true, lines: ["Parking for 40 cars is included.", "Generator fuel is billed at cost.", "The lawn closes at 10 pm."] } },
    }));
    ok(rN1.code === 201, `generated with three numbered notes (${rN1.code})`);
    const dN1 = await VenueLeadDocument.findById(rN1.body.documentId).lean();
    ok(dN1.docNotes && dN1.docNotes.numbered === true && dN1.docNotes.lines.length === 3, "…stored as a LIST on the document");
    const fN1 = pdfFlat(lastUpload().buffer);
    has(fN1, "Notes", "the section prints with its heading");
    has(fN1, "1. Parking for 40 cars is included.", "…line 1 numbered at render");
    has(fN1, "2. Generator fuel is billed at cost.", "…line 2");
    has(fN1, "3. The lawn closes at 10 pm.", "…line 3");
    // regeneration WITHOUT docNotes → the previous version's notes survive
    const rN2 = await call(send.storeQuoteDocument, req({ params: { enquiryId: String(lead._id) }, body: { quoteId: String(quote._id) } }));
    const dN2 = await VenueLeadDocument.findById(rN2.body.documentId).lean();
    ok(dN2.docNotes && dN2.docNotes.lines.length === 3, "🔴 notes SURVIVE regeneration — the new version carries them");
    has(pdfFlat(lastUpload().buffer), "2. Generator fuel is billed at cost.", "…and prints them");
    // delete the MIDDLE note → the third renumbers to 2
    const rN3 = await call(send.storeQuoteDocument, req({
      params: { enquiryId: String(lead._id) },
      body: { quoteId: String(quote._id), docNotes: { numbered: true, lines: ["Parking for 40 cars is included.", "The lawn closes at 10 pm."] } },
    }));
    const fN3 = pdfFlat(lastUpload().buffer);
    has(fN3, "2. The lawn closes at 10 pm.", "🔴 deleting the middle note RENUMBERS the rest — derived, never baked");
    hasNot(fN3, "3. ", "…and no third number remains");
    ok(rN3.code === 201, `…that generation stored (${rN3.code})`);
    // numbering off → plain lines
    const rN4 = await call(send.storeQuoteDocument, req({
      params: { enquiryId: String(lead._id) },
      body: { quoteId: String(quote._id), docNotes: { numbered: false, lines: ["Parking for 40 cars is included."] } },
    }));
    const fN4 = pdfFlat(lastUpload().buffer);
    has(fN4, "Parking for 40 cars is included.", "numbering off: the line prints");
    hasNot(fN4, "1. Parking for 40 cars is included.", "…without a number");
    ok(rN4.code === 201, `…stored (${rN4.code})`);
    // explicit empty list → the section is gone, not resurrected
    const rN5 = await call(send.storeQuoteDocument, req({
      params: { enquiryId: String(lead._id) },
      body: { quoteId: String(quote._id), docNotes: { numbered: false, lines: [] } },
    }));
    hasNot(pdfFlat(lastUpload().buffer), "Notes", "clearing every line clears the section — an emptied body is not inherited over");
    ok(rN5.code === 201, `…stored (${rN5.code})`);
    // the options endpoint hands the latest notes back for the editor
    const rOpt2 = await call(opts.documentOptions, req({ params: { enquiryId: String(lead._id) } }));
    ok(!rOpt2.body.notesByKind.quote, "notesByKind reflects the cleared state");
    // NO RECTANGLES near the notes — the §8b probes, WITH a notes section live
    const { buildVenueDocument } = require("../utils/docsystem");
    const rectFill = /(?:^|[\s])(?:[\d.]+ ){4}re\s*\n?\s*f[\s\n]/;
    const rectStroke = /(?:^|[\s])(?:[\d.]+ ){4}re\s*\n?\s*S[\s\n]/;
    for (const language of LANGUAGE_NAMES) {
      const built = await buildVenueDocument("quote", {
        venue: venue.toObject(), lead, quote: qStored,
        docNotes: { numbered: true, lines: ["Parking for 40 cars.", "Fuel at cost."] },
      }, { compress: false, language });
      const raw = built.buffer.toString("latin1");
      if (language === "panel") ok(!rectStroke.test(raw), "panel: notes bring no stroked rectangle");
      else ok(!rectFill.test(raw) && !rectStroke.test(raw), `${language}: notes bring ZERO rectangle ops — a rule, never a box`);
    }

    // ══ 4. BOOKING + PAYMENTS: invoice choices legible, receipt filed ═══════
    console.log("\n[4. the GST-first split made legible; the receipt gains a stored artefact]");
    const P1 = new mongoose.Types.ObjectId(), P2 = new mongoose.Types.ObjectId();
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: lead.coupleName, couplePhone: lead.couplePhone,
      status: "confirmed", gstPercent: 18, gstMode: "none", totalValue: 520000, scheduleIncludesGst: true,
      lineItems: [
        { label: "Venue rental", amount: 500000, gstTreatment: "full", taxableAmount: 0, refundable: false },
        { label: "Cleaning", amount: 20000, gstTreatment: "none", taxableAmount: 0, refundable: false },
      ],
      paymentSchedule: [
        { label: "Token", amount: 200000, dueDate: new Date("2026-10-01"), entries: [{ amount: 200000, date: new Date("2026-10-01"), method: "cash", reference: "", status: "approved", paymentId: P1, approvedAt: new Date() }] },
        { label: "Balance", amount: 410000, dueDate: new Date("2026-12-01"), entries: [{ amount: 410000, date: new Date("2026-12-02"), method: "bank_transfer", reference: "UTR-77", status: "approved", paymentId: P2, approvedAt: new Date() }] },
      ],
    });
    const rOpt3 = await call(opts.documentOptions, req({ params: { enquiryId: String(lead._id) } }));
    const k3 = rOpt3.body.kinds;
    ok(k3.invoice.available && k3.invoice.gstFirst === true, "invoice: available, GST-first named");
    ok(k3.confirmation.available && k3.statement.available && k3.receipt.available, "confirmation, statement, receipt all available now");
    const pTok = k3.invoice.payments.find((p) => p.paymentId === String(P1));
    const pBal = k3.invoice.payments.find((p) => p.paymentId === String(P2));
    // taxed stream = 500000×1.18 = 590000 collectable; token 200000 sits inside it
    ok(pTok && pTok.willSplit === false && pTok.taxedShare === 200000 && pTok.untaxedShare === 0,
      `a payment inside the taxed stream does NOT split (${pTok && pTok.taxedShare}/${pTok && pTok.untaxedShare})`);
    ok(pBal && pBal.willSplit === true && pBal.taxedShare === 390000 && pBal.untaxedShare === 20000,
      `🔴 the spanning payment says it will split BEFORE the button — Rs. 3,90,000 taxed + Rs. 20,000 ordinary (${pBal && pBal.taxedShare}/${pBal && pBal.untaxedShare})`);
    // the receipt, FILED as a document through the new endpoint
    const rRc = await call(leadPayment.storeReceiptDocument, req({ params: { enquiryId: String(lead._id), paymentId: String(P1) }, body: { docNotes: { numbered: false, lines: ["Received in cash at the estate office."] } } }));
    ok(rRc.code === 201, `receipt filed (${rRc.code})`);
    const rcDoc = await VenueLeadDocument.findById(rRc.body.documentId).lean();
    ok(rcDoc && rcDoc.kind === "receipt", "…as kind 'receipt' in the documents list");
    const fRc = pdfFlat(lastUpload().buffer);
    has(fRc, "Received, with thanks", "…document-system bytes");
    has(fRc, "Received in cash at the estate office.", "…carrying its note");
    const rRcBad = await call(leadPayment.storeReceiptDocument, req({ params: { enquiryId: String(lead._id), paymentId: String(new mongoose.Types.ObjectId()) } }));
    ok(rRcBad.code === 404 && rRcBad.body.code === "no_receiptable_payment", `an unknown payment refuses with the reason (${rRcBad.code})`);
    // notes carry on OTHER kinds too: statement through its endpoint
    const stmt = require("../controllers/venueLeadStatement");
    const rSt = await call(stmt.createStatement, req({ params: { enquiryId: String(lead._id) }, body: { docNotes: { numbered: true, lines: ["Figures as reconciled on 12 September."] } } }));
    ok([200, 201].includes(rSt.code), `statement generated (${rSt.code})`);
    has(pdfFlat(lastUpload().buffer), "1. Figures as reconciled on 12 September.", "…statement carries its numbered note");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      const v = await Venue.findOne({ slug: new RegExp(`^${TAG}`) }).lean();
      if (v) {
        await VenueLeadDocument.deleteMany({ venue: v._id });
        await VenueInvoice.deleteMany({ venue: v._id });
        await VenueBooking.deleteMany({ venue: v._id });
        await VenueQuote.deleteMany({ venue: v._id });
        await VenueEnquiry.deleteMany({ venueId: v._id });
        await Venue.deleteMany({ _id: v._id });
      }
    } catch (_) { /* disposable test DB */ }
    await mongoose.disconnect();
  }
})();

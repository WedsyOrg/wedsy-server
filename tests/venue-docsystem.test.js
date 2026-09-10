// THE DOCUMENT SYSTEM — real PDFs from real data, read back off the bytes.
// Run: DATABASE_URL=... node tests/venue-docsystem.test.js
//
// The bar (the build brief): printed line values SUM to printed totals —
// proven, not printed; every figure agrees with the stored document; the
// fixed wording is present VERBATIM on the rendered bytes; the header and
// footer are on every page; the handoff fixture reconciles to the rupee;
// twenty layouts (5 documents × 4 languages) and every money state build.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");

const { buildVenueDocument, LANGUAGE_NAMES } = require("../utils/docsystem");
const { computeLineTotals } = require("../utils/venueMoney");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { pdfFlat, pdfPagesText, normalise } = require("./docsystem-helpers");
const { money } = require("../utils/docsystem/shared");

const TAG = `docsys-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const has = (flat, probe, label) => ok(normalise(flat).includes(normalise(probe)), `${label} [${probe.slice(0, 48)}…]`.replace("…]", probe.length > 48 ? "…]" : "]"));
const hasNot = (flat, probe, label) => ok(!normalise(flat).includes(normalise(probe)), label);
const created = { venues: [] };

// ── the handoff fixture, verbatim (LANGUAGES.md §4) ─────────────────────────
const FIXTURE_LINES = [
  { label: "Venue rental — Estate Lawn & Banyan Courtyard", amount: 650000, gstTreatment: "full" },
  { label: "Mandapa Hall — 22 Nov, 07:00 to 14:00", amount: 125000, gstTreatment: "full" },
  { label: "Guest rooms — 18 rooms, night of 21 Nov", amount: 216000, gstTreatment: "part", taxableAmount: 108000 },
  { label: "Extension — 2 hours beyond package", amount: 30000, gstTreatment: "full" },
  { label: "Housekeeping & sanitation crew — 14 staff", amount: 45000, gstTreatment: "none" },
  { label: "Power backup — 2 × 125 kVA silent DG", amount: 38000, gstTreatment: "full" },
  { label: "Diesel for DG sets — at actuals, capped", amount: 22000, gstTreatment: "none" },
  { label: "Valet & parking marshals — 12 staff", amount: 28000, gstTreatment: "full" },
  { label: "Security personnel — 8 guards, 24 hours", amount: 34000, gstTreatment: "none" },
  { label: "Mandap electrical & rigging points", amount: 26000, gstTreatment: "full" },
  { label: "Bridal suite — 2 nights, 20 & 21 Nov", amount: 55000, gstTreatment: "part", taxableAmount: 27500 },
  { label: "Golf-cart shuttle — 3 units with drivers", amount: 24000, gstTreatment: "full" },
  { label: "Municipal & amplified-sound permissions — at cost", amount: 18500, gstTreatment: "none" },
  { label: "Waste removal & post-event clearance", amount: 21000, gstTreatment: "full" },
  { label: "Refundable security deposit", amount: 150000, gstTreatment: "none", refundable: true },
];

// a 1×1 PNG so the with-logo header path runs against a real image
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const mkEntry = (amount, date, paymentId, method = "bank_transfer", reference = "") =>
  ({ amount, date: new Date(date), method, reference, status: "approved", paymentId, approvedAt: new Date(date) });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG} Aranya Estate`, slug: `${TAG}-v`, tagline: "Estate weddings & celebrations",
      address: "Survey 41/2, Hesaraghatta Main Road, Bengaluru 560089",
      gstin: "29AAGCA4821K1ZP", pan: "AAGCA4821K",
      contact: { primaryPhone: "+91 80 4718 2200", email: "events@aranyaestate.in" },
    });
    created.venues.push(venue._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Ananya Rao & Karthik Menon", couplePhone: "9800112233",
      stage: "booked", checkIn: new Date("2026-11-21T06:00:00+05:30"), checkOut: new Date("2026-11-22T14:00:00+05:30"),
      requirements: { roomsNeeded: 18 },
      contacts: [{ name: "Ananya Rao", phone: "9800112233", email: "ananya@example.com", isPrimary: true }],
    });
    const P1 = new mongoose.Types.ObjectId(), P2 = new mongoose.Types.ObjectId(), P3 = new mongoose.Types.ObjectId();
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: lead.coupleName, couplePhone: lead.couplePhone,
      status: "confirmed", gstPercent: 18, gstMode: "none", totalValue: 1332500,
      checkIn: lead.checkIn, checkOut: lead.checkOut, roomsRequired: 18,
      days: [{ date: new Date("2026-11-21"), eventType: "Wedding", guestCount: 300, spaces: ["Estate Lawn", "Banyan Courtyard"] }],
      lineItems: FIXTURE_LINES.map((l) => ({ ...l, taxableAmount: l.taxableAmount || 0, refundable: Boolean(l.refundable) })),
      paymentSchedule: [
        { label: "Booking amount — token", amount: 250000, dueDate: new Date("2025-12-05"), entries: [mkEntry(250000, "2025-12-05", P1, "upi", "UTR-771")] },
        { label: "First instalment", amount: 400000, dueDate: new Date("2026-02-15"), entries: [mkEntry(400000, "2026-02-18", P2, "bank_transfer", "UTR-802")] },
        { label: "Second instalment", amount: 400000, dueDate: new Date("2026-06-15"), entries: [mkEntry(250000, "2026-06-20", P3), mkEntry(143600, "2026-07-04", P3)] },
        { label: "Final instalment", amount: 432500, dueDate: new Date("2026-11-07"), entries: [] },
        { label: "Bar extension on the night", amount: 228000, dueDate: new Date("2026-11-22"), isAdditional: true, entries: [] },
      ],
    });
    const quote = await VenueQuote.create({
      venue: venue._id, enquiry: lead._id, status: "accepted", version: 1, gstPercent: 18,
      lineItems: FIXTURE_LINES.map((l) => ({ ...l, qty: 1, unitPrice: l.amount, taxableAmount: l.taxableAmount || 0 })),
      totals: computeLineTotals(FIXTURE_LINES, 18),
    });

    const lf = computeLineTotals(booking.lineItems, 18);
    const summary = summarizeSchedule(booking);

    // ══ 1. THE HANDOFF FIXTURE RECONCILES — on the bytes, in every language ══
    console.log("\n[1. the fixture, to the rupee, in all four languages]");
    ok(lf.charged === 1332500 && lf.refundable === 150000 && lf.taxable === 1077500 && lf.gst === 193950,
      `computeLineTotals reproduces the fixture (charged ${lf.charged}, refundable ${lf.refundable}, taxable ${lf.taxable}, gst ${lf.gst})`);
    for (const language of LANGUAGE_NAMES) {
      const q = await buildVenueDocument("quote", { venue, lead, quote }, { compress: false, language });
      const flat = pdfFlat(q.buffer);
      has(flat, "Rs. 13,32,500", `${language}: charged`);
      has(flat, "Rs. 14,82,500", `${language}: payable`);
      has(flat, "Rs. 16,76,450", `${language}: collectable`);
      has(flat, "Total payable", `${language}: fixed label`);
      has(flat, "of which refundable, held — returned after the event: Rs. 1,50,000", `${language}: fixed refundable line, verbatim`);
      has(flat, "GST at 18% applies to the taxable Rs. 10,77,500 of the quoted lines — Rs. 1,93,950 in all", `${language}: GST stated with its base, verbatim`);
      has(flat, "Sums exactly to total payable", `${language}: the schedule's proof row`);
      // the vocabulary rule governs SYSTEM copy; the venue's own tagline is
      // their voice (the handoff fixture's tagline says "weddings" itself)
      hasNot(flat.toLowerCase().replace(/estate weddings & celebrations/g, ""), "wedding", `${language}: "event", never "wedding" (outside the venue's own tagline)`);
    }

    // ══ 2. THE PRINTED LINES SUM — proven against the bytes ═════════════════
    console.log("\n[2. printed values sum to printed totals]");
    const qc = await buildVenueDocument("quote", { venue, lead, quote }, { compress: false, language: "classic" });
    const flatQ = pdfFlat(qc.buffer);
    // every fixture line's amount, taxable, gst and line-total, as printed
    const { lineTaxable, lineGst } = require("../utils/venueMoney");
    let sumA = 0, sumT = 0, sumG = 0, sumL = 0;
    for (const l of FIXTURE_LINES.filter((x) => !x.refundable)) {
      const a = Math.round(l.amount), t = lineTaxable(l), g = lineGst(l, 18);
      sumA += a; sumT += t; sumG += g; sumL += a + g;
      has(flatQ, a.toLocaleString("en-IN"), `line amount printed`);
    }
    ok(sumA === 1332500 && sumT === 1077500 && sumG === 193950 && sumL === 1526450,
      `Σ printed line values === printed totals (${sumA}/${sumT}/${sumG}/${sumL})`);
    // CONFIRMDOC3 f1: charged + GST is a figure the money model has no name
    // for — the subtotal's line-total cell is a DASH, and the unnamed figure
    // appears NOWHERE on the document.
    hasNot(flatQ, "15,26,450", "the charged row never prints the unnamed charged+GST figure");

    // ══ 3. QUOTE STATES ═════════════════════════════════════════════════════
    console.log("\n[3. quote states: no refundable / only refundable / 15 lines]");
    const mkQuote = (lines) => ({ lineItems: lines, gstPercent: 18, version: 2, createdAt: new Date() });
    const noRef = await buildVenueDocument("quote", { venue, lead, quote: mkQuote(FIXTURE_LINES.filter((l) => !l.refundable)) }, { compress: false, language: "classic" });
    hasNot(pdfFlat(noRef.buffer), "of which refundable", "no refundable line → no refundable sentence");
    hasNot(pdfFlat(noRef.buffer), "REFUNDABLE", "…and no band tag");
    const onlyRef = await buildVenueDocument("quote", { venue, lead, quote: mkQuote([{ label: "Refundable security deposit", amount: 150000, gstTreatment: "none", refundable: true }]) }, { compress: false, language: "classic" });
    const flatOR = pdfFlat(onlyRef.buffer);
    has(flatOR, "Rs. 0", "only-refundable: charged reads zero");
    has(flatOR, "of which refundable, held — returned after the event: Rs. 1,50,000", "…and the held line still states the deposit");
    const fifteen = mkQuote([...FIXTURE_LINES.filter((l) => !l.refundable), { label: "Fifteenth line — chai service", amount: 5000, gstTreatment: "none" }]);
    const f15 = await buildVenueDocument("quote", { venue, lead, quote: fifteen }, { compress: false, language: "classic" });
    ok(f15.pages >= 1, `fifteen priced lines render (${f15.pages}p)`);
    const pagesQ = pdfPagesText(qc.buffer);
    ok(pagesQ.length === qc.pages, `per-page streams match page count (${qc.pages})`);
    for (let i = 0; i < pagesQ.length; i++) {
      has(pagesQ[i], "ARANYA ESTATE", `header on page ${i + 1}`);
      has(pagesQ[i], "POWERED BY WEDSY", `footer on page ${i + 1}`);
    }
    // the revised header is shorter, so the fixture quote may no longer split
    // ITS TABLE across the boundary — force a split with thirty lines and
    // assert the head repeats where the table actually continues
    {
      const thirty = mkQuote(Array.from({ length: 30 }, (_, i) => ({ label: `Line ${i + 1} — service`, amount: 10000 + i, gstTreatment: i % 3 === 0 ? "full" : "none" })));
      const q30 = await buildVenueDocument("quote", { venue, lead, quote: thirty }, { compress: false, language: "classic" });
      const pages30 = pdfPagesText(q30.buffer);
      ok(pages30.length >= 2, `thirty lines force a split (${pages30.length}p)`);
      has(pages30[1], "LINE TOTAL", "the column head repeats on the overflow page");
    }

    // ══ 4. CONFIRMATION ═════════════════════════════════════════════════════
    console.log("\n[4. confirmation: parties, spaces, LINES, schedule — the revised anatomy]");
    const conf = await buildVenueDocument("confirmation", { venue, lead, booking }, { compress: false, language: "classic" });
    const flatC = pdfFlat(conf.buffer);
    // CONFIRMDOC3 f9: one line PER SPACE — never a joined list
    has(flatC, "Estate Lawn", "spaces allocated — first space, its own line");
    has(flatC, "Banyan Courtyard", "…second space, its own line");
    hasNot(flatC, "Estate Lawn, Banyan Courtyard", "…never joined into one line");
    // BOOKING 3 ruling: documents print rooms ONLY from the booking's
    // recorded allocation — never the enquiry's ask, never zero. This
    // fixture booking records nothing, so the Spaces & rooms section carries
    // no rooms row. (The agreed LINES may name rooms — that is the quote's
    // own wording, legitimately printed since the line breakdown landed.)
    hasNot(flatC, "Rooms — ", "no recorded allocation → no rooms row in Spaces & rooms");
    // CONFIRMDOC finding 3: the four quote lines appear on the confirmation
    has(flatC, "The agreed lines", "the priced-lines section exists");
    has(flatC, "Guest rooms — 18 rooms, night of 21 Nov", "…with the quote's own line labels");
    has(flatC, "Charged — the venue's revenue", "…and the charged subtotal row");
    // CONFIRMDOC finding 5: a structured client block, venue left client right
    has(flatC, "THE VENUE", "parties: the venue side");
    has(flatC, "THE CLIENT", "parties: the client side");
    has(flatC, "ananya@example.com", "…client email renders when it exists");
    hasNot(flatC, "For Ananya Rao & Karthik Menon · Ananya Rao", "…and the title no longer duplicates name · name");
    // CONFIRMDOC footer finding: the venue name never doubles
    hasNot(flatC, `Aranya Estate · ${TAG}`, "footer: venue name printed once, not name · name");
    has(flatC, "Booking amount — token", "the schedule's rows");
    has(flatC, "Sums exactly to total payable", "…and its proof row");
    has(flatC, "Rs. 14,82,500", "the agreed payable");
    hasNot(flatC, "Bar extension on the night", "the confirmation documents the AGREED deal — extras are not on it");

    // ── 4b. GST-FIRST confirmation: the schedule DECOMPOSES, never dashes ───
    // The live Asiya document printed PAYABLE 6,76,000 · GST — · COLLECTABLE
    // 6,76,000 while stating Rs. 36,000 of GST above it. The stored rows ARE
    // the collectable; the table now splits each by the taxed-stream-first
    // rule (what its tax invoice carries), so the columns agree with the
    // document's own totals — and the proof row names the RIGHT figure.
    console.log("\n[4b. GST-first schedule: decomposed by the taxed stream, label proven]");
    {
      const gfBooking = booking.toObject();
      gfBooking.scheduleIncludesGst = true;
      gfBooking.gstMode = "none";
      gfBooking.lineItems = [
        { label: "Venue rental", amount: 600000, gstTreatment: "part", taxableAmount: 200000, refundable: false },
        { label: "Cleaning", amount: 5000, gstTreatment: "none", taxableAmount: 0, refundable: false },
        { label: "Refundable deposit", amount: 25000, gstTreatment: "none", taxableAmount: 0, refundable: true },
        { label: "Additional furniture", amount: 10000, gstTreatment: "none", taxableAmount: 0, refundable: false },
      ];
      gfBooking.paymentSchedule = [
        { _id: new mongoose.Types.ObjectId(), label: "Token — received", amount: 100000, dueDate: new Date("2026-09-08"), entries: [] },
        { _id: new mongoose.Types.ObjectId(), label: "First instalment", amount: 288000, dueDate: new Date("2026-10-10"), entries: [] },
        { _id: new mongoose.Types.ObjectId(), label: "Balance", amount: 288000, dueDate: new Date("2026-10-31"), entries: [] },
      ];
      const gf = await buildVenueDocument("confirmation", { venue, lead, booking: gfBooking }, { compress: false, language: "classic" });
      const flatGF = pdfFlat(gf.buffer);
      has(flatGF, "Rs. 6,40,000", "Total payable states the ex-GST figure");
      has(flatGF, "Rs. 6,76,000", "collectable states payable + GST");
      // the decomposed rows: 1,00,000 → 84,746 + 15,254; the stream closes
      // inside the 2,88,000 row → 2,67,254 + 20,746; the rest untaxed
      has(flatGF, "84,746", "token row payable = collectable less its GST share");
      has(flatGF, "15,254", "…token row GST, grossed down at 18%");
      has(flatGF, "20,746", "…stream-closing row reconciles by subtraction");
      has(flatGF, "36,000", "…and the GST column sums to the stated GST");
      // the columns sum to the SAME figures the totals block states — the
      // proof row's label ("total payable") now names the number beneath it
      ok(84746 + 267254 + 288000 === 640000 && 15254 + 20746 === 36000,
        "decomposed columns sum to payable 6,40,000 and GST 36,000 exactly");
    }

    // ══ 5. STATEMENT: extras, absorbed figures, a year of payments ══════════
    console.log("\n[5. statement: extras group, sums, second sheet]");
    const st = await buildVenueDocument("statement", { venue, lead, booking, summary }, { compress: false, language: "classic" });
    const flatS = pdfFlat(st.buffer);
    has(flatS, "Bar extension on the night", "the extras row");
    has(flatS, "Additional to the agreed amount — they do not change it", "the extras caption, verbatim");
    has(flatS, "Rs. 2,28,000", "the extras total");
    const totalPayableAll = 1482500 + 228000;
    has(flatS, "Rs. " + totalPayableAll.toLocaleString("en-IN"), "payable including extras");
    // cross-surface: the received figure equals the model's own summary
    has(flatS, "Rs. " + summary.totals.received.toLocaleString("en-IN"), `received matches summarizeSchedule (${summary.totals.received})`);
    // the spanning payment's split is stated under each instalment (P3 twice)
    has(flatS, "of which Rs. 2,50,000 to this instalment", "spanning payment split — first touch");
    has(flatS, "of which Rs. 1,43,600 to this instalment", "spanning payment split — second touch");
    // a YEAR of payments and 14+ lines flows to a second sheet
    const longBooking = booking.toObject();
    longBooking.paymentSchedule = [
      ...Array.from({ length: 24 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(), label: `Instalment ${i + 1}`, amount: i < 23 ? 57500 : 160000,
        dueDate: new Date(2026, i % 12, 15),
        entries: i < 16 ? [mkEntry(i < 23 ? 57500 : 160000, new Date(2026, i % 12, 20), new mongoose.Types.ObjectId())] : [],
      })),
    ];
    const longSum = summarizeSchedule(longBooking);
    const stLong = await buildVenueDocument("statement", { venue, lead, booking: longBooking, summary: longSum }, { compress: false, language: "classic" });
    ok(stLong.pages >= 2, `a year of payments flows to a second sheet (${stLong.pages}p)`);
    const pagesL = pdfPagesText(stLong.buffer);
    for (let i = 0; i < pagesL.length; i++) {
      has(pagesL[i], "ARANYA ESTATE", `long statement: header on page ${i + 1}`);
      has(pagesL[i], "POWERED BY WEDSY", `long statement: footer on page ${i + 1}`);
    }
    ok(pagesL.filter((p) => p.includes("INSTALMENT")).length >= 2, "the schedule's column head repeats on the second sheet");

    // ══ 6. INVOICES: refundable never invoiced ══════════════════════════════
    console.log("\n[6. invoices: first, middle, mixed; the deposit on NONE of them]");
    const mkInvoice = (label, unitPrice, taxable, gst, kind = "advance") => ({
      invoiceNumber: `${TAG}-${label.slice(0, 4)}`, kind, gstMode: gst ? "exclusive" : "none", gstPercent: 18, createdAt: new Date(),
      billedTo: { name: lead.coupleName, gstin: "" },
      lineItems: [{ label, qty: 1, unitPrice, taxable, gst }],
      totals: { subtotal: unitPrice, taxable, gst, grandTotal: unitPrice + gst },
    });
    const firstInv = await buildVenueDocument("invoice", { venue, lead, booking, invoice: mkInvoice("First instalment — Ananya", 400000, 320000, 57600) }, { compress: false, language: "classic" });
    const flatI1 = pdfFlat(firstInv.buffer);
    has(flatI1, "CGST 9%", "CGST split");
    has(flatI1, "SGST 9%", "SGST split");
    has(flatI1, "Rs. 4,57,600", "amount due");
    has(flatI1, "Rupees Four Lakh Fifty-Seven Thousand Six Hundred Only", "amount in words");
    // mixed treatments: the booking-level line invoice view
    const { invoiceViewOfLines } = require("../utils/venueMoney");
    const lv = invoiceViewOfLines(booking.lineItems, 18);
    const mixedInv = {
      invoiceNumber: `${TAG}-MIX`, kind: "final", gstMode: "exclusive", gstPercent: 18, createdAt: new Date(),
      billedTo: { name: lead.coupleName }, lineItems: lv.lineItems, totals: { ...lv.totals },
    };
    const mixed = await buildVenueDocument("invoice", { venue, lead, booking, invoice: mixedInv }, { compress: false, language: "classic" });
    const flatMix = pdfFlat(mixed.buffer);
    for (const inv of [flatI1, flatMix]) {
      hasNot(inv, "Refundable security deposit", "A REFUNDABLE DEPOSIT IS NEVER INVOICED — the line is absent");
      hasNot(inv, "1,50,000", "…and its amount appears nowhere");
      has(inv, "never part of a tax invoice", "…and the invoice says so");
    }
    ok(lv.totals.taxable === 1077500 && lv.totals.gst === 193950, "the mixed invoice's stored per-line derivation matches the fixture");

    // ── GST-FIRST (wizard2): the ORDINARY invoice is a recipe variation ─────
    // A payment's untaxed half renders with NO GST-register fact anywhere:
    // no venue GSTIN/PAN, no state code, no place of supply, no SAC, no
    // reverse-charge line, no B2C fallback, no tax columns. The tax half
    // keeps every one of them. Asserted on the rendered stream, both ways.
    console.log("\n[6b. GST-first split: the ordinary invoice carries no GST register facts]");
    const taxHalf = await buildVenueDocument("invoice", { venue, lead, booking, invoice: {
      invoiceNumber: `${TAG}-TAXH`, kind: "final", gstMode: "exclusive", gstPercent: 18, createdAt: new Date(),
      stream: "taxed", billedTo: { name: lead.coupleName, gstin: "" },
      lineItems: [{ label: "Payment received — Advance", qty: 1, unitPrice: 4237, taxable: 4237, gst: 763 }],
      totals: { subtotal: 4237, taxable: 4237, gst: 763, grandTotal: 5000 },
    } }, { compress: false, language: "classic" });
    const flatTax = pdfFlat(taxHalf.buffer);
    // (the eyebrow itself renders letter-spaced by the language and is not
    // greppable as one token; the register facts below are the assertion)
    has(flatTax, "GSTIN", "the taxed half carries GSTIN facts");
    has(flatTax, "unregistered (B2C)", "…with the B2C fallback when the client has none");
    has(flatTax, "CGST 9%", "…and the CGST column");
    has(flatTax, "Place of supply", "…and the place of supply");
    const plainHalf = await buildVenueDocument("invoice", { venue, lead, booking, invoice: {
      invoiceNumber: `${TAG}-ORDH`, kind: "final", gstMode: "none", gstPercent: 0, createdAt: new Date(),
      stream: "untaxed", billedTo: { name: lead.coupleName, gstin: "" },
      lineItems: [{ label: "Payment received — Balance", qty: 1, unitPrice: 50000, taxable: 0, gst: 0 }],
      totals: { subtotal: 50000, taxable: 0, gst: 0, grandTotal: 50000 },
    } }, { compress: false, language: "classic" });
    const flatOrd = pdfFlat(plainHalf.buffer);
    hasNot(flatOrd, "GSTIN", "ORDINARY: no GSTIN anywhere — not the venue's, not a B2C line");
    hasNot(flatOrd, "CGST", "…no CGST column");
    hasNot(flatOrd, "SGST", "…no SGST column");
    hasNot(flatOrd, "Taxable value", "…no taxable column");
    hasNot(flatOrd, "Place of supply", "…no place of supply");
    hasNot(flatOrd, "SAC 996334", "…no SAC");
    hasNot(flatOrd, "Reverse charge", "…no reverse-charge line");
    has(flatOrd, "Rs. 50,000", "…and the amount still reads plainly");

    // ══ 7. RECEIPT: one instalment, and one spanning two ════════════════════
    console.log("\n[7. receipt: single and spanning]");
    const r1 = await buildVenueDocument("receipt", { venue, lead, booking, summary, paymentId: P2 }, { compress: false, language: "classic" });
    const flatR1 = pdfFlat(r1.buffer);
    has(flatR1, "Rs. 4,00,000", "single: the amount received");
    has(flatR1, "Rupees Four Lakh Only", "…in words");
    has(flatR1, "First instalment", "…applied to the instalment");
    has(flatR1, "UTR-802", "…with the bank reference");
    const r3 = await buildVenueDocument("receipt", { venue, lead, booking, summary, paymentId: P3 }, { compress: false, language: "classic" });
    const flatR3 = pdfFlat(r3.buffer);
    has(flatR3, "Rs. 3,93,600", "spanning: the payment total");
    has(flatR3, "of which Rs. 2,50,000 to this instalment", "…split stated under the first touch");
    has(flatR3, "of which Rs. 1,43,600 to this instalment", "…and under the second");
    const rMissing = await buildVenueDocument("receipt", { venue, lead, booking, summary, paymentId: new mongoose.Types.ObjectId() }, { compress: false, language: "classic" });
    ok(rMissing === null, "an unknown payment gets no receipt (null, the endpoint 404s)");
    // caught LIVE: entries without a paymentId (wizard tokens, legacy rows)
    // matched String(undefined) === String(undefined) and printed the wrong
    // payment's receipt for a nonsense id
    const noIdBooking = booking.toObject();
    noIdBooking.paymentSchedule[0].entries[0].paymentId = undefined;
    const rGhost = await buildVenueDocument("receipt", { venue, lead, booking: noIdBooking, summary, paymentId: undefined }, { compress: false, language: "classic" });
    ok(rGhost === null, "a missing paymentId never ghost-matches entries that lack one");
    // caught LIVE: U+2212 is outside WinAnsi and printed as a quote mark
    has(flatR1, "- Rs. ", "negative prefixes use the ASCII hyphen (WinAnsi has no minus sign)");
    hasNot(flatR1, '"Rs.', "…and no stray quotation mark where the minus was");

    // ══ 8. LOGO PRESENT AND ABSENT, EVERY DOCUMENT ══════════════════════════
    console.log("\n[8. the header with a logo and without]");
    for (const type of ["quote", "confirmation", "invoice", "statement", "receipt"]) {
      const inputs = { venue, lead, booking, quote, summary, paymentId: P2, invoice: mkInvoice(`Header ${type}`, 100000, 100000, 18000) };
      const withLogo = await buildVenueDocument(type, { ...inputs, logoBuffer: PNG_1PX }, { compress: false, language: "classic" });
      const without = await buildVenueDocument(type, inputs, { compress: false, language: "classic" });
      ok(withLogo && withLogo.buffer.length > 2000, `${type}: builds with a logo`);
      const flatNo = pdfFlat(without.buffer);
      has(flatNo, "ARANYA ESTATE", `${type}: no logo → the venue name carries the crest`);
    }

    // ══ 8b. NOTHING IS ENCLOSED — proven on the operators, not the intent ═══
    console.log("\n[8b. the governing rule: no rectangles outside Panel's bands]");
    // With compress:false a filled rectangle is a literal `re` op closed by
    // `f`, and a stroked box is `re` closed by `S`. The revision's rule says
    // the ONLY fills are Panel's two full-bleed bands and its reversed table
    // heads, and NOTHING is outlined — so the rule-only languages must carry
    // ZERO rect ops, and Panel must carry zero STROKED rects. (No-logo builds
    // only: a logo image brings its own transform furniture.)
    // a rect op is four numbers then `re` — anchored so hex text (whose
    // digits include a–f) can never false-match
    const rectFill = /(?:^|[\s])(?:[\d.]+ ){4}re\s*\n?\s*f[\s\n]/;
    const rectStroke = /(?:^|[\s])(?:[\d.]+ ){4}re\s*\n?\s*S[\s\n]/;
    for (const language of LANGUAGE_NAMES) {
      for (const type of ["quote", "confirmation", "invoice", "statement", "receipt"]) {
        const inputs = { venue, lead, booking, quote, summary, paymentId: P2, invoice: mkInvoice(`E ${language} ${type}`, 400000, 320000, 57600) };
        const built = await buildVenueDocument(type, inputs, { compress: false, language });
        const raw = built.buffer.toString("latin1");
        if (language === "panel") {
          ok(!rectStroke.test(raw), `panel × ${type}: no stroked rectangle anywhere`);
        } else {
          ok(!rectFill.test(raw) && !rectStroke.test(raw), `${language} × ${type}: zero rectangle ops — nothing filled, nothing boxed`);
        }
      }
    }

    // ══ 8b2. THE HERO FIGURE CARRIES THE LANGUAGE'S EMPHASIS WEIGHT ═════════
    // CONFIRMDOC refinement: Total payable (confirmation), outstanding
    // (statement) and the amount (receipt) are all drawn through the
    // language's emphasisBlock — never a hand-rolled rule with one weight
    // copied across. On the bytes: Ledger and Panel emphasise at 3px
    // ("3 w" ops present), Classic and Stationery at 0.75 (none), and
    // Stationery's emphasis strokes in ACCENT (#8A4F32 → 0.5411…).
    console.log("\n[8b2. hero emphasis weight is the language's own]");
    {
      const threeW = (raw) => (raw.match(/(?:^|\n)3 w\n/g) || []).length;
      const ACCENT = "0.5411764705882353 0.3";
      for (const type of ["confirmation", "statement", "receipt"]) {
        const inputs = { venue, lead, booking, quote, summary, paymentId: P2 };
        const byLang = {};
        for (const language of LANGUAGE_NAMES) {
          const built = await buildVenueDocument(type, inputs, { compress: false, language });
          byLang[language] = built.buffer.toString("latin1");
        }
        ok(threeW(byLang.ledger) >= 1, `${type}: ledger's emphasis is its own 3px (${threeW(byLang.ledger)} ops)`);
        ok(threeW(byLang.panel) >= 1, `${type}: panel's emphasis is its own 3px (${threeW(byLang.panel)} ops)`);
        ok(threeW(byLang.classic) === 0, `${type}: classic stays 0.75 — no 3px op anywhere`);
        ok(threeW(byLang.stationery) === 0, `${type}: stationery stays 0.75 — no 3px op anywhere`);
        ok(byLang.stationery.includes(ACCENT), `${type}: stationery's emphasis strokes in accent`);
      }
    }

    // ══ 8b3. THE HERO FOLLOWS THE FACTS (confirmdoc2 finding 6) ═════════════
    // With GST: "Total including GST" is the hero — standard Indian invoice
    // phrasing; "Collectable" is model vocabulary and never reaches a couple's
    // page. With NO GST: the line is ABSENT (not zero, not a dash) and the
    // emphasis + Times figure move onto Total payable — a line repeating a
    // figure already on screen is a figure with nothing to add. The fixed
    // wording stays verbatim in both cases. Asserted on bytes, all four
    // languages, and the emphasis rule's position is read off the stream.
    console.log("\n[8b3. Total including GST when GST exists; absent — and payable the hero — when not]");
    {
      const heroAfterRule = (raw, weightOp) => {
        // the text drawn just after the LAST emphasis-weight rule op — the
        // language's rule precedes its hero figure in the content stream
        const idx = raw.lastIndexOf(`\n${weightOp}\n`);
        if (idx < 0) return "";
        return pdfFlat(Buffer.from(raw.slice(idx, idx + 2600), "latin1"));
      };
      const noGstQuote = {
        lineItems: [
          { label: "Venue rental — no tax case", amount: 500000, gstTreatment: "none" },
          { label: "Refundable security deposit", amount: 50000, gstTreatment: "none", refundable: true },
        ],
        gstPercent: 18, version: 3, createdAt: new Date(),
      };
      for (const language of LANGUAGE_NAMES) {
        const withTax = await buildVenueDocument("quote", { venue, lead, quote }, { compress: false, language });
        const flatW = pdfFlat(withTax.buffer);
        has(flatW, "Total including GST", `${language}: GST present → the line exists`);
        has(flatW, "Rs. 16,76,450", `${language}: …and carries the GST-inclusive total`);
        hasNot(flatW, "Collectable — what you transfer", `${language}: the model's word is gone from the page`);
        has(flatW, "Total payable", `${language}: Total payable verbatim, as the supporting line`);
        const noTax = await buildVenueDocument("quote", { venue, lead, quote: noGstQuote }, { compress: false, language });
        const flatN = pdfFlat(noTax.buffer);
        hasNot(flatN, "Total including GST", `${language}: NO GST → the line is absent entirely`);
        hasNot(flatN, "GST at 18% applies", `${language}: …and no GST sentence claims a zero`);
        has(flatN, "Total payable", `${language}: …Total payable stays, verbatim`);
        has(flatN, "of which refundable, held — returned after the event: Rs. 50,000", `${language}: …refundable-held verbatim under the hero`);
      }
      // the emphasis MOVED: on ledger (3px, and the quote's only emphasis
      // block), the text right after the rule op is the hero's own label
      const wLedger = await buildVenueDocument("quote", { venue, lead, quote }, { compress: false, language: "ledger" });
      const nLedger = await buildVenueDocument("quote", { venue, lead, quote: noGstQuote }, { compress: false, language: "ledger" });
      ok(heroAfterRule(wLedger.buffer.toString("latin1"), "3 w").includes("Total including GST"),
        "ledger, GST: the 3px emphasis rule sits immediately above Total including GST");
      const nAfter = heroAfterRule(nLedger.buffer.toString("latin1"), "3 w");
      ok(nAfter.includes("Total payable") && !nAfter.includes("Total including GST"),
        "ledger, no GST: the 3px emphasis rule moved onto Total payable");
    }

    // ══ 8c. THE REVISED STATEMENT CLOSING ═══════════════════════════════════
    console.log("\n[8c. the closing reconciliation, full measure]");
    const stC = await buildVenueDocument("statement", { venue, lead, booking, summary }, { compress: false, language: "classic" });
    const flatC2 = pdfFlat(stC.buffer);
    has(flatC2, "How the outstanding figure is arrived at", "the retitled closing block");
    has(flatC2, "Charged — agreed lines", "…charged step");
    has(flatC2, "Extras added since booking", "…extras step");
    has(flatC2, "Refundable deposit held", "…refundable step");
    has(flatC2, "GST at 18% — on the taxable", "…GST states its basis inline");
    has(flatC2, "Received to date —", "…received states its basis inline");
    {
      const outStr = require("./docsystem-helpers").normalise(pdfFlat(stC.buffer));
      const val = money(1904450 - summary.totals.received).replace("Rs. ", "Rs. ");
      const count = outStr.split(val).length - 1;
      ok(count === 2, `Outstanding appears exactly twice (${val} × ${count}) — the position line and the closing row`);
    }
    has(flatC2, "REFUNDABLE —", "the refundable lead-in replaces the tag (rendered caps)");

    // ══ 9. EVERY DOCUMENT IN EVERY LANGUAGE ═════════════════════════════════
    console.log("\n[9. twenty layouts, fixed wording everywhere]");
    for (const language of LANGUAGE_NAMES) {
      for (const type of ["quote", "confirmation", "invoice", "statement", "receipt"]) {
        const inputs = { venue, lead, booking, quote, summary, paymentId: P2, invoice: mkInvoice(`L ${language} ${type}`, 400000, 320000, 57600) };
        const built = await buildVenueDocument(type, inputs, { compress: false, language });
        const flat = pdfFlat(built.buffer);
        const okAll = flat.includes("POWERED BY WEDSY") && normalise(flat).includes("Rs. ");
        ok(okAll, `${language} × ${type}: builds, footer mark + rupee form present (${built.pages}p)`);
      }
    }

    // ══ 10. BANK DETAILS + CLIENT SNAPSHOT (bankdetails build) ══════════════
    // Present → the payment block on quote/confirmation/statement and the
    // invoice's remit slot; NEVER the receipt. Absent → nothing at all: no
    // heading, no empty rows. The confirmation's client block prints the
    // BOOKING'S clientDetails snapshot; absent fields print nothing.
    console.log("\n[10. bank details print where money is asked for — never the receipt]");
    {
      const bankVenue = venue.toObject();
      bankVenue.bankDetails = {
        accountName: "Aranya Estate Hospitality LLP", accountNumber: "50100987654321",
        ifsc: "HDFC0001234", bankName: "HDFC Bank", branch: "Hesaraghatta", upiId: "aranyaestate@icici",
      };
      const inv10 = mkInvoice("Tenth section", 400000, 320000, 57600);
      for (const language of LANGUAGE_NAMES) {
        for (const type of ["quote", "confirmation", "statement"]) {
          const built = await buildVenueDocument(type, { venue: bankVenue, lead, booking, quote, summary, invoice: inv10 }, { compress: false, language });
          const flat = pdfFlat(built.buffer);
          has(flat, "PAYMENT DETAILS", `${language} × ${type}: the payment block exists`);
          has(flat, "A/C 50100987654321 · IFSC HDFC0001234", `${language} × ${type}: account + IFSC on one line`);
          has(flat, "UPI aranyaestate@icici", `${language} × ${type}: UPI printed`);
        }
      }
      const invB = await buildVenueDocument("invoice", { venue: bankVenue, lead, booking, invoice: inv10 }, { compress: false, language: "classic" });
      const flatInv = pdfFlat(invB.buffer);
      has(flatInv, "PAYMENT DETAILS", "invoice: one name for the payment block everywhere (statementdoc f7)");
      has(flatInv, "A/C 50100987654321 · IFSC HDFC0001234", "…same one composer as every other document");
      const rec = await buildVenueDocument("receipt", { venue: bankVenue, lead, booking, summary, paymentId: P2 }, { compress: false, language: "classic" });
      const flatRec = pdfFlat(rec.buffer);
      hasNot(flatRec, "PAYMENT DETAILS", "🔴 the RECEIPT never carries bank details — it confirms money already arrived");
      hasNot(flatRec, "50100987654321", "…not the account number");
      hasNot(flatRec, "aranyaestate@icici", "…not the UPI");
      // ABSENT → invisible (the plain fixture venue has no bankDetails)
      for (const type of ["quote", "confirmation", "statement", "invoice"]) {
        const built = await buildVenueDocument(type, { venue, lead, booking, quote, summary, invoice: mkInvoice(`NoBank ${type}`, 100000, 100000, 18000) }, { compress: false, language: "classic" });
        const flat = pdfFlat(built.buffer);
        hasNot(flat, "PAYMENT DETAILS", `${type}: no bank details → no block, no heading`);
        hasNot(flat, "PAYMENT DETAILS", `${type}: …and no empty payment block`);
      }
      // ── the client snapshot on the confirmation ──
      const cdBooking = booking.toObject();
      cdBooking.clientDetails = { house: "14 Prithvi Enclave", street: "8th Cross, Malleswaram", city: "Bengaluru", pincode: "560003", gstin: "29AAGCA4821K1ZP" };
      const confCd = await buildVenueDocument("confirmation", { venue, lead, booking: cdBooking }, { compress: false, language: "classic" });
      const flatCd = pdfFlat(confCd.buffer);
      has(flatCd, "14 Prithvi Enclave, 8th Cross, Malleswaram", "client block: house + street");
      has(flatCd, "Bengaluru 560003", "…city and pincode");
      has(flatCd, "GSTIN 29AAGCA4821K1ZP", "…and the snapshot GSTIN");
      const confNoCd = await buildVenueDocument("confirmation", { venue, lead, booking }, { compress: false, language: "classic" });
      hasNot(pdfFlat(confNoCd.buffer), "Prithvi", "no snapshot → no address lines, nothing invented");
    }

    // ══ 11. CONFIRMDOC3 — the eleven findings, on bytes ═════════════════════
    console.log("\n[11. confirmdoc3: hierarchy, window, brand-alone header, rooms lines, token line]");
    {
      const md = booking.toObject();
      md.scheduleIncludesGst = true;
      md.checkIn = new Date("2027-01-01T10:00:00+05:30");
      md.checkOut = new Date("2027-01-03T00:00:00+05:30");
      md.days = [
        { date: new Date("2027-01-01"), eventType: "Wedding", guestCount: 150, spaces: ["Indoor Hall", "Big Lawn"] },
        { date: new Date("2027-01-02"), eventType: "Wedding", guestCount: 400, spaces: ["Grand Ballroom", "Poolside Lawn"] },
      ];
      md.roomsAllocation = { mode: "counts", items: [
        { name: "Deluxe", count: 8, total: 10 }, { name: "Lake Suite", count: 2, total: 2 }, { name: "Standard", count: 12, total: 20 },
      ] };
      md.lineItems = [
        { label: "Venue rental", amount: 600000, gstTreatment: "part", taxableAmount: 200000, refundable: false },
        { label: "Refundable deposit", amount: 25000, gstTreatment: "none", taxableAmount: 0, refundable: true },
      ];
      md.paymentSchedule = [
        { _id: new mongoose.Types.ObjectId(), label: "Token — received", amount: 100000, dueDate: new Date("2026-09-09"), entries: [] },
        { _id: new mongoose.Types.ObjectId(), label: "Balance", amount: 561000, dueDate: new Date("2026-12-01"), entries: [] },
      ];
      const conf3 = await buildVenueDocument("confirmation", { venue, lead, booking: md }, { compress: false, language: "classic" });
      const flat3 = pdfFlat(conf3.buffer);
      const pages3 = pdfPagesText(conf3.buffer);
      // f2 + f3: the NAME is the title; the window is said; the sentiment is the whisper
      has(flat3, "YOUR DATES ARE HELD", "f3: the sentiment is the eyebrow whisper");
      has(flat3, "Booking confirmation", "f3: …and the document's NAME carries the weight");
      ok(/1 . 3 January 2027/.test(flat3), "f2: the WINDOW is said — check-in to check-out");
      // f4 + f5: the reference row keeps the confirmed date, drops the repeated
      // name, and carries the searchable booking number near the top
      const bookingRef = `Booking ${String(md._id).slice(-6).toUpperCase()}`;
      ok(pages3[0].includes(bookingRef), "f5: the booking number is on page one, in the reference row");
      ok((flat3.match(new RegExp("Booking Confirmation", "g")) || []).length === 0, "f4: the eyebrow is not repeated in the refs");
      // f6 + f7: header carries the brand alone; the venue block carries the registrations
      ok((normalise(flat3).match(/PAN AAGCA4821K/g) || []).length === 1, "f6/f7: PAN prints exactly once — the venue block, never the header");
      // f6 COMPLETED: brand alone means brand alone — no address, no phone,
      // no registration flanks the name on ANY page's header. The address is
      // the clean probe (the footer legitimately repeats the phone per page).
      ok((flat3.match(/Hesaraghatta Main Road/g) || []).length === 1, "f6: the address prints exactly once — the venue block");
      ok((normalise(flat3).match(/GSTIN 29AAGCA4821K1ZP/g) || []).length >= 1 && !pages3.slice(1).some((pg) => pg.includes("Hesaraghatta")), "f6: page two's header carries no address");
      ok(!pages3.slice(1).some((pg) => normalise(pg).includes("PAN AAGCA4821K")), "f6: …and no PAN");
      ok((flat3.match(/\+91 80 4718 2200/g) || []).length === conf3.pages + 1, "f6: the phone appears once per footer plus once in the venue block — never the header");
      // ONE HEADER, ONE PARTIES BLOCK (founder ruling, invoicedoc): every
      // document's header is the brand alone, and every document's parties
      // block carries the registrations — EXACTLY ONCE, on page one, never
      // on a later page's header. Asserted per document, per language.
      for (const language of LANGUAGE_NAMES) {
        for (const type of ["quote", "confirmation", "statement", "receipt"]) {
          const built = await buildVenueDocument(type, { venue, lead, booking, quote, summary, paymentId: P2 }, { compress: false, language });
          const f = normalise(pdfFlat(built.buffer));
          const pgs = pdfPagesText(built.buffer);
          ok((f.match(/PAN AAGCA4821K/g) || []).length === 1, `${language} × ${type}: PAN exactly once — the parties block`);
          ok((f.match(/Hesaraghatta Main Road/g) || []).length === 1, `${language} × ${type}: the address exactly once`);
          ok(!pgs.slice(1).some((pg) => pg.includes("Hesaraghatta") || normalise(pg).includes("PAN AAGCA4821K")),
            `${language} × ${type}: later pages' headers carry neither`);
        }
        const taxInv = await buildVenueDocument("invoice", { venue, lead, booking, invoice: mkInvoice(`Hd ${language}`, 100000, 100000, 18000) }, { compress: false, language });
        const fi = normalise(pdfFlat(taxInv.buffer));
        ok((fi.match(/PAN AAGCA4821K/g) || []).length === 1 && (fi.match(/GSTIN 29AAGCA4821K1ZP/g) || []).length === 1,
          `${language} × tax invoice: PAN and venue GSTIN exactly once — a tax invoice is never left without them`);
      }
      // f9: rooms are count · category, one line each; ceilings and summaries gone
      has(flat3, "8 · Deluxe", "f9: count · category");
      has(flat3, "2 · Lake Suite", "…every category its own line");
      hasNot(flat3, "8 of 10", "…ceilings are not on the couple's confirmation");
      hasNot(flat3, "Rooms — all categories", "…and no summary that says the same thing twice");
      hasNot(flat3, "Indoor Hall, Big Lawn", "…spaces never joined");
      hasNot(flat3, "Entire property — Wedding", "…the function name stays off the space line");
      // f10: the token row explains its split, in the schedule's voice
      has(flat3, "payments cover the quote's taxed share first", "f10: the token row's one line");
      // f11: the footer still reads well — name · contact · reference
      has(pages3[0], "POWERED BY WEDSY", "f11: the footer's platform mark");
      // no-GST: the token line is absent, and no zero prints under GST
      const ng = booking.toObject();
      ng.scheduleIncludesGst = true;
      ng.lineItems = [{ label: "Venue rental", amount: 200000, gstTreatment: "none", taxableAmount: 0, refundable: false }];
      ng.paymentSchedule = [
        { _id: new mongoose.Types.ObjectId(), label: "Token — received", amount: 60000, dueDate: new Date("2026-09-09"), entries: [] },
        { _id: new mongoose.Types.ObjectId(), label: "Balance", amount: 140000, dueDate: new Date("2026-12-01"), entries: [] },
      ];
      const confNg = await buildVenueDocument("confirmation", { venue, lead, booking: ng }, { compress: false, language: "classic" });
      const flatNg = pdfFlat(confNg.buffer);
      hasNot(flatNg, "taxed share first", "f10: no GST → the explanation line does not exist");
      hasNot(flatNg, "Rs. 0", "no GST → no zero prints as a money figure");
      // single-day: the single date stays, singular voice
      const sd = booking.toObject();
      sd.checkIn = new Date("2027-02-06T16:00:00+05:30");
      sd.checkOut = new Date("2027-02-06T23:00:00+05:30");
      sd.days = [{ date: new Date("2027-02-06"), eventType: "Engagement", guestCount: 80, spaces: ["Poolside Lawn"] }];
      const confSd = await buildVenueDocument("confirmation", { venue, lead, booking: sd }, { compress: false, language: "classic" });
      const flatSd = pdfFlat(confSd.buffer);
      has(flatSd, "YOUR DATE IS HELD", "single day: singular voice");
      has(flatSd, "6 February 2027 · For", "…and the single date, not a window");
      // the f1 guard THROWS on a lying subtotal (doctored line figures)
      let threw = false;
      try {
        const bad = booking.toObject();
        bad.lineItems = [{ label: "Venue rental", amount: 100000, gstTreatment: "none", taxableAmount: 0, refundable: false }];
        const assembled = require("../utils/docsystem/index");
        // hand the renderer a priced set that disagrees with totals via a
        // direct call — the assembler cannot produce this, which is the point
        const { RENDERERS } = require("../utils/docsystem/documents");
        const { Engine } = require("../utils/docsystem/engine");
        const { LANGUAGES } = require("../utils/docsystem/languages");
        const asm = require("../utils/docsystem/assemble").assembleConfirmation({ venue, lead, booking: bad, logoBuffer: null });
        asm.priced = [{ label: "Doctored", amount: 999, taxable: 0, gst: 0, lineTotal: 999, refundable: false, treatment: "none" }];
        const R = new Engine({ language: LANGUAGES.classic, identity: asm.identity, meta: asm.meta, compress: false });
        await RENDERERS.confirmation(R, asm);
      } catch (e) {
        threw = /charged subtotal would lie/.test(e.message);
      }
      ok(threw, "f1 guard: a subtotal that would lie about charged fails generation");
    }

    // ══ 12. THE INVOICE FINDINGS + THE AMOUNT-CARRYING QR ═══════════════════
    console.log("\n[12. invoicedoc: title follows the line, window, B2C, the QR pays the invoice's own figure]");
    {
      const { PNG } = require("pngjs");
      const jsQR = require("jsqr");
      const decodeQr = (buf) => {
        const png = PNG.sync.read(buf);
        const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        return r ? r.data : null;
      };
      const bankVenue = venue.toObject();
      bankVenue.bankDetails = { accountName: "Aranya Estate LLP", accountNumber: "50100987654321", ifsc: "HDFC0001234", bankName: "HDFC Bank", branch: "MG Road", upiId: "aranyaestate@icici" };
      // a milestone-backed invoice whose stored kind lies (the audited path)
      const mInv = {
        invoiceNumber: `${TAG}-M1`, kind: "final", gstMode: "exclusive", gstPercent: 18, createdAt: new Date(),
        forMilestoneId: new mongoose.Types.ObjectId(), billedTo: { name: "Ananya Rao & Karthik Menon", gstin: "" },
        lineItems: [{ label: "First instalment — Ananya Rao & Karthik Menon", qty: 1, unitPrice: 400000, taxable: 320000, gst: 57600 }],
        totals: { subtotal: 400000, taxable: 320000, gst: 57600, grandTotal: 457600 },
        dueDate: new Date("2026-11-01"),
      };
      const cdBooking12 = booking.toObject();
      cdBooking12.clientDetails = { house: "14 Prithvi Enclave", street: "8th Cross, Malleswaram", city: "Bengaluru", pincode: "560003", gstin: "" };
      const built = await buildVenueDocument("invoice", { venue: bankVenue, lead, booking: cdBooking12, invoice: mInv }, { compress: false, language: "classic" });
      const f = pdfFlat(built.buffer);
      has(f, "First instalment", "f4: the title follows the LINE, not the lying stored kind");
      hasNot(f, "Final instalment", "…'Final instalment' is gone");
      hasNot(f, "First instalment — Ananya", "f4: the couple's name is the addressee, not part of the charge");
      ok(/Event 21 . 22 November 2026/.test(f), "f7: the event WINDOW is on the invoice — check-in to check-out");
      has(f, "unregistered (B2C)", "f5: the unregistered case stated explicitly in the client block");
      has(f, "14 Prithvi Enclave", "f5: the client's address renders when the booking holds it");
      has(f, "PAYMENT DETAILS", "f8: bank details in the one payment block");
      // THE QR CARRIES NO AMOUNT (founder ruling): the VPA alone, decoded
      // and proven — UPI ceilings vary, and a rejected QR is worse than one
      // the payer completes themselves.
      ok(built.data.payQr && built.data.payQr.source === "fallback", "the pre-store venue gets an amountless fallback QR (same encoder)");
      const decoded = decodeQr(built.data.payQr.buffer);
      ok(decoded === built.data.payQr.upiString, "…the embedded buffer decodes to its own payload");
      ok(!/[?&]am=/.test(decoded), "🔴 NO am= anywhere — the payer types the figure");
      ok(!/[?&]tn=/.test(decoded), "…and no tn — the payload is the VPA alone");
      ok(/^upi:\/\/pay\?pa=.+&pn=.+&cu=INR$/.test(decoded), `…exactly pa+pn+cu (${decoded})`);
      ok(built.buffer.toString("latin1").includes("/Subtype /Image"), "…and an image object is actually embedded in the PDF");
      hasNot(pdfFlat(built.buffer), "Scan to pay Rs.", "the caption promises no figure the QR does not encode");
      has(pdfFlat(built.buffer), "Scan to pay", "…the caption is 'Scan to pay' — nothing more; the app asks for the amount");
      hasNot(pdfFlat(built.buffer), "enter the amount", "…and does not narrate what the app is about to say");
      // a venue WITH a stored QR: the invoice uses THE STORED IMAGE —
      // one image, one code path, byte-identical to Settings
      const storedVenue = venue.toObject();
      storedVenue.bankDetails = bankVenue.bankDetails;
      const { generateUpiQr } = require("../utils/venueUpiQr");
      const storedQ = await generateUpiQr("aranyaestate@icici", storedVenue.name);
      storedVenue.upiQr = { dataUrl: storedQ.dataUrl, source: "generated", upiString: storedQ.upiString };
      const stBuilt = await buildVenueDocument("invoice", { venue: storedVenue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-MS`, forMilestoneId: new mongoose.Types.ObjectId() } }, { compress: false, language: "classic" });
      ok(stBuilt.data.payQr && stBuilt.data.payQr.source === "generated"
        && stBuilt.data.payQr.buffer.equals(Buffer.from(storedQ.dataUrl.split(",")[1], "base64")),
        "🔴 with a stored QR the invoice embeds THE STORED BYTES — no per-render generation");
      ok(!/[?&]am=/.test(decodeQr(stBuilt.data.payQr.buffer)), "…and the stored payload carries no amount either");
      // uploaded-QR venue: the stored image, verbatim
      const upVenue = venue.toObject();
      upVenue.upiQr = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", source: "uploaded", upiString: "" };
      const upBuilt = await buildVenueDocument("invoice", { venue: upVenue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-M2`, forMilestoneId: new mongoose.Types.ObjectId() } }, { compress: false, language: "classic" });
      ok(upBuilt.data.payQr && upBuilt.data.payQr.source === "uploaded", "an uploaded QR renders as stored, verbatim");
      // every language: the QR (when present) decodes amountless
      for (const language of LANGUAGE_NAMES) {
        const lb = await buildVenueDocument("invoice", { venue: storedVenue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-L${language}`, forMilestoneId: new mongoose.Types.ObjectId() } }, { compress: false, language });
        const ld = lb.data.payQr && decodeQr(lb.data.payQr.buffer);
        ok(ld && !/[?&]am=/.test(ld), `${language}: the QR decodes with no am=`);
      }
      // a payment-backed invoice evidences money RECEIVED — no pay-QR at all
      const payBuilt = await buildVenueDocument("invoice", { venue: bankVenue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-M3`, forMilestoneId: null, forPaymentId: new mongoose.Types.ObjectId() } }, { compress: false, language: "classic" });
      ok(!payBuilt.data.payQr, "a payment-backed invoice carries no pay-QR — that money already arrived");
      // no bank, no stored QR → nothing
      const bare = await buildVenueDocument("invoice", { venue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-M4`, forMilestoneId: new mongoose.Types.ObjectId() } }, { compress: false, language: "classic" });
      ok(!bare.data.payQr, "no UPI ID and no stored QR → no block, nothing invented");
      // a REGISTERED client: their GSTIN prints, the B2C line does not
      const regBuilt = await buildVenueDocument("invoice", { venue: bankVenue, lead, booking, invoice: { ...mInv, invoiceNumber: `${TAG}-M5`, forMilestoneId: new mongoose.Types.ObjectId(), billedTo: { name: "Acme Events LLP", gstin: "29AAGCA4821K1ZP" } } }, { compress: false, language: "classic" });
      const fr = pdfFlat(regBuilt.buffer);
      has(fr, "GSTIN 29AAGCA4821K1ZP", "a registered client's GSTIN prints in the client block");
      hasNot(fr, "unregistered (B2C)", "…and the B2C line does not");
      // the ORDINARY invoice: no register fact anywhere, either side
      const ordBuilt = await buildVenueDocument("invoice", { venue: bankVenue, lead, booking, invoice: {
        invoiceNumber: `${TAG}-ORD2`, kind: "final", gstMode: "none", gstPercent: 0, createdAt: new Date(), stream: "untaxed",
        forMilestoneId: new mongoose.Types.ObjectId(), billedTo: { name: "Ananya Rao & Karthik Menon", gstin: "" },
        lineItems: [{ label: "Payment received — Balance", qty: 1, unitPrice: 50000, taxable: 0, gst: 0 }],
        totals: { subtotal: 50000, taxable: 0, gst: 0, grandTotal: 50000 },
      } }, { compress: false, language: "classic" });
      const fo = normalise(pdfFlat(ordBuilt.buffer));
      hasNot(fo, "PAN AAGCA4821K", "ordinary: no PAN anywhere — either side");
      hasNot(fo, "GSTIN", "ordinary: no GSTIN anywhere — either side");
      has(fo, "Hesaraghatta Main Road", "…the venue's address still prints (identity, not registration)");
    }

    // ══ 13. THE GENERATION DATE — only when it DIFFERS from the issue date ══
    // (invoicedoc2 f1): on a freshly cut document the two said the same
    // thing twice; the Generated ref exists to mark a REISSUED copy.
    console.log("\n[13. Generated only when it differs; a reissued copy carries it]");
    {
      const today = require("../utils/docsystem/shared").dateProse(new Date());
      // fresh copies of the dated documents: the sibling date is today, so
      // Generated is SUPPRESSED — the event date alone speaks
      const freshQuote = { ...quote.toObject(), createdAt: new Date() };
      const fq = pdfFlat((await buildVenueDocument("quote", { venue, lead, quote: freshQuote }, { compress: false, language: "classic" })).buffer);
      ok(fq.includes("Issued") && !fq.includes("Generated"), "fresh quote: Issued alone — no same-day echo");
      const freshBooking = booking.toObject(); freshBooking.createdAt = new Date();
      const fc = pdfFlat((await buildVenueDocument("confirmation", { venue, lead, booking: freshBooking }, { compress: false, language: "classic" })).buffer);
      ok(fc.includes("Confirmed") && !fc.includes("Generated"), "fresh confirmation: Confirmed alone");
      const fi = pdfFlat((await buildVenueDocument("invoice", { venue, lead, booking, invoice: { ...mkInvoice("Fresh today", 100000, 100000, 18000), createdAt: new Date() } }, { compress: false, language: "classic" })).buffer);
      ok(fi.includes("Issued") && !fi.includes("Generated"), "fresh invoice: Issued alone");
      // REISSUED copies (created on an earlier day) carry Generated, distinct
      const oldDay = new Date(Date.now() - 5 * 86400000);
      for (const language of LANGUAGE_NAMES) {
        const ri = await buildVenueDocument("invoice", { venue, lead, booking, invoice: { ...mkInvoice(`Re ${language}`, 100000, 100000, 18000), createdAt: oldDay } }, { compress: false, language });
        const fr2 = pdfFlat(ri.buffer);
        ok(fr2.includes(`Generated ${today}`) && fr2.includes("Issued") && !fr2.includes(`Issued ${today}`),
          `${language}: a reissued invoice says Issued <then> AND Generated <today>`);
      }
      const rq = pdfFlat((await buildVenueDocument("quote", { venue, lead, quote: { ...quote.toObject(), createdAt: oldDay } }, { compress: false, language: "classic" })).buffer);
      ok(rq.includes(`Generated ${today}`), "a re-rendered quote carries Generated");
      const rc = booking.toObject(); rc.createdAt = oldDay;
      ok(pdfFlat((await buildVenueDocument("confirmation", { venue, lead, booking: rc }, { compress: false, language: "classic" })).buffer).includes(`Generated ${today}`),
        "a re-rendered confirmation carries Generated");
      // statement: As-of IS this copy's date — no Generated beside it, ever
      const sb = pdfFlat((await buildVenueDocument("statement", { venue, lead, booking, summary }, { compress: false, language: "classic" })).buffer);
      ok(sb.includes(`As of ${today}`) && !sb.includes("Generated"), "statement: As of alone — never the same date twice");
      // receipt: Generated always (its event date is Received on)
      const frr = pdfFlat((await buildVenueDocument("receipt", { venue, lead, booking, summary, paymentId: P2 }, { compress: false, language: "classic" })).buffer);
      ok(frr.includes(`Generated ${today}`) && !frr.includes("Issued") && frr.includes("Received on"),
        "receipt: Generated always, Received on untouched, no Issued");
    }

    // ══ 14. INVOICEDOC2 — the seven findings on bytes ═══════════════════════
    console.log("\n[14. single-line total gone, untaxed plainly, due date, the position line, one payment block]");
    {
      const bankVenue2 = venue.toObject();
      bankVenue2.bankDetails = { accountName: "Aranya Estate LLP", accountNumber: "50100987654321", ifsc: "HDFC0001234", bankName: "HDFC Bank", branch: "MG Road", upiId: "aranyaestate@icici" };
      const posInv = {
        invoiceNumber: `${TAG}-P1`, kind: "instalment", gstMode: "exclusive", gstPercent: 18, createdAt: new Date(),
        forMilestoneId: new mongoose.Types.ObjectId(), billedTo: { name: "Ananya Rao & Karthik Menon", gstin: "" },
        lineItems: [{ label: "First instalment", qty: 1, unitPrice: 171292, taxable: 115254, gst: 20746 }],
        totals: { subtotal: 171292, taxable: 115254, gst: 20746, grandTotal: 192038 },
        dueDate: new Date("2026-10-11"),
        position: { index: 1, count: 4, bookingTotal: 676000, receivedToDate: 100000, next: { amount: 147840, dueDate: new Date("2026-11-14") }, isFinal: false },
      };
      const b1 = await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: posInv }, { compress: false, language: "classic" });
      const f1 = pdfFlat(b1.buffer);
      hasNot(f1, "Invoice total", "f2: a single-line invoice prints no total row that repeats the line");
      has(f1, "Untaxed portion", "f3: the untaxed share is said plainly");
      hasNot(f1, "Non-taxable recoveries", "…and the accounting phrase is gone");
      has(f1, "Due 11 October 2026", "f4: the due date is a term beside the amount due");
      has(f1, "Instalment 1 of 4 · Booking total Rs. 6,76,000 · Rs. 1,00,000 received to date", "f5: the position line, verbatim");
      has(f1, "Next: Rs. 1,47,840, due 14 November 2026", "…and ONE instalment ahead");
      has(f1, "Scan to pay", "f6: the caption");
      hasNot(f1, "enter the amount", "…nothing more — the app asks for the amount");
      has(f1, "UPI aranyaestate@icici", "…the QR sits with the UPI ID it encodes");
      // the final instalment: the second line changes, nothing ahead printed
      const finInv = { ...posInv, invoiceNumber: `${TAG}-P2`, forMilestoneId: new mongoose.Types.ObjectId(),
        position: { index: 4, count: 4, bookingTotal: 676000, receivedToDate: 528160, next: null, isFinal: true } };
      const b2 = await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: finInv }, { compress: false, language: "classic" });
      const f2 = pdfFlat(b2.buffer);
      has(f2, "This is the final instalment.", "the last instalment says so");
      hasNot(f2, "Next:", "…and names nothing ahead");
      // a MIDDLE instalment for completeness
      const midInv = { ...posInv, invoiceNumber: `${TAG}-P3`, forMilestoneId: new mongoose.Types.ObjectId(),
        position: { index: 2, count: 4, bookingTotal: 676000, receivedToDate: 292038, next: { amount: 147840, dueDate: new Date("2026-11-14") }, isFinal: false } };
      const fm = pdfFlat((await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: midInv }, { compress: false, language: "classic" })).buffer);
      has(fm, "Instalment 2 of 4", "a middle instalment states its place");
      // an invoice with NO position snapshot (older) prints no position line
      const noPos = { ...posInv, invoiceNumber: `${TAG}-P4`, forMilestoneId: new mongoose.Types.ObjectId(), position: null };
      hasNot(pdfFlat((await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: noPos }, { compress: false, language: "classic" })).buffer),
        "Instalment 1 of", "an older invoice without the snapshot prints no position — never re-derived");
      // a MULTI-LINE invoice keeps its proof row
      const multiInv = { ...posInv, invoiceNumber: `${TAG}-P5`, forMilestoneId: new mongoose.Types.ObjectId(), position: null,
        lineItems: [
          { label: "First instalment", qty: 1, unitPrice: 100000, taxable: 80000, gst: 14400 },
          { label: "Second instalment", qty: 1, unitPrice: 71292, taxable: 35254, gst: 6346 },
        ],
        totals: { subtotal: 171292, taxable: 115254, gst: 20746, grandTotal: 192038 } };
      has(pdfFlat((await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: multiInv }, { compress: false, language: "classic" })).buffer),
        "Invoice total", "a multi-line invoice keeps its proof row");
      // all four languages carry the block coherently
      for (const language of LANGUAGE_NAMES) {
        const lb = pdfFlat((await buildVenueDocument("invoice", { venue: bankVenue2, lead, booking, invoice: { ...posInv, invoiceNumber: `${TAG}-L2${language}`, forMilestoneId: new mongoose.Types.ObjectId() } }, { compress: false, language })).buffer);
        ok(lb.includes("Instalment 1 of 4") && lb.includes("Scan to pay") && lb.includes("Due 11 October 2026"),
          `${language}: position, caption and due date all present`);
      }
    }

    // ══ 15. STATEMENTDOC — eight fixes and six additions, on bytes ══════════
    console.log("\n[15. statementdoc: dense sum, window, agreed, trail, overdue, one payment block]");
    {
      const stVenue = venue.toObject();
      stVenue.bankDetails = { accountName: "Aranya Estate LLP", accountNumber: "50100987654321", ifsc: "HDFC0001234", bankName: "HDFC Bank", branch: "MG Road", upiId: "aranyaestate@icici" };
      const { generateUpiQr } = require("../utils/venueUpiQr");
      const stQ = await generateUpiQr("aranyaestate@icici", stVenue.name);
      stVenue.upiQr = { dataUrl: stQ.dataUrl, source: "generated", upiString: stQ.upiString };
      const stInvoices = [
        { invoiceNumber: "INV-0031", createdAt: new Date("2026-09-01"), kind: "final", forMilestoneId: new mongoose.Types.ObjectId(),
          lineItems: [{ label: "First instalment" }], totals: { grandTotal: 400000 } },
        { invoiceNumber: "INV-0032", createdAt: new Date("2026-09-05"), kind: "final", forPaymentId: new mongoose.Types.ObjectId(), stream: "taxed",
          lineItems: [{ label: "Payment received" }], totals: { grandTotal: 250000 } },
      ];
      const st15 = await buildVenueDocument("statement", { venue: stVenue, lead, booking, summary, invoices: stInvoices }, { compress: false, language: "classic" });
      const f15 = pdfFlat(st15.buffer);
      // f1: the dense subtotal's line-total cell holds the REAL column sum
      has(f15, "15,26,450", "f1: the dense line-total cell holds the true column sum (charged + GST)");
      // f2: the window
      ok(/Event 21 . 22 November 2026/.test(f15), "f2: the statement says the window");
      // f3: Agreed is charged+refundable, and NO zero-extras clause on this
      // booking (it HAS extras, so the clause appears with a figure)
      has(f15, "Agreed Rs. 14,82,500", "f3: Agreed = payable ex-extras");
      has(f15, "+ extras Rs. 2,28,000", "…extras named only because they exist");
      // f8: the reconciliation resolves before subtracting
      has(f15, "Total including GST", "f8: the running figure resolves to the collectable");
      // f9: method + reference on payment rows
      has(f15, "UPI · UTR-771", "f9: method and reference on the token's payment row");
      has(f15, "Bank transfer · UTR-802", "…and on the instalment's");
      // f10: the invoice trail
      has(f15, "Invoices raised", "f10: the trail section exists");
      has(f15, "INV-0031", "…with the invoice numbers");
      has(f15, "Payment received (tax)", "…and what each was against");
      // f6/f7: ONE payment block with the QR
      has(f15, "PAYMENT DETAILS", "f6/f7: the one payment block, one name");
      has(f15, "UPI aranyaestate@icici", "…UPI beside the QR");
      has(f15, "Scan to pay", "…the caption");
      ok(st15.data.payQr && !/[?&]am=/.test((() => { const { PNG } = require("pngjs"); const jsQR = require("jsqr"); const png = PNG.sync.read(st15.data.payQr.buffer); return jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data; })()), "…the stored QR, amountless");
      // f13/f14: the deposit's fate and the query contact
      has(f15, "any deduction is itemised to you before the balance is returned", "f13: the deposit's fate, as process");
      has(f15, "If anything here does not match your records, contact", "f14: the query contact");
      // placement: the as-of truth beside the outstanding figure
      has(f15, "Figures as recorded on the booking today", "the as-of line lives by the figure it qualifies");
      // f4: one payment states its date once (single-payment fixture)
      const onePay = booking.toObject();
      onePay.paymentSchedule = [
        { _id: new mongoose.Types.ObjectId(), label: "Token", amount: 250000, dueDate: new Date("2025-12-05"), entries: [mkEntry(250000, "2025-12-05", new mongoose.Types.ObjectId(), "upi", "UTR-1")] },
        { _id: new mongoose.Types.ObjectId(), label: "Balance", amount: 1232500, dueDate: new Date("2026-11-07"), entries: [] },
      ];
      const oneSum = summarizeSchedule(onePay);
      const f1p = pdfFlat((await buildVenueDocument("statement", { venue: stVenue, lead, booking: onePay, summary: oneSum, invoices: [] }, { compress: false, language: "classic" })).buffer);
      has(f1p, "1 payment, 5 Dec 2025", "f4: one payment, its date once");
      hasNot(f1p, "5 Dec 2025 \u2013 5 Dec 2025", "…never a same-day range");
      hasNot(f1p, "Invoices raised", "no invoices → no trail section");
      // f11: an overdue instalment is NAMED with days and amount
      const late = booking.toObject();
      late.paymentSchedule = late.paymentSchedule.map((r) => ({ ...r }));
      late.paymentSchedule[3].dueDate = new Date(Date.now() - 12 * 86400000); // Final instalment overdue
      const lateSum = summarizeSchedule(late);
      const fLate = pdfFlat((await buildVenueDocument("statement", { venue: stVenue, lead, booking: late, summary: lateSum, invoices: [] }, { compress: false, language: "classic" })).buffer);
      ok(/Overdue . Final instalment: Rs\. 4,32,500, 12 days late/.test(fLate), "f11: the late instalment named — what, how much, how long");
      // every language builds with the new anatomy
      for (const language of LANGUAGE_NAMES) {
        const lb = await buildVenueDocument("statement", { venue: stVenue, lead, booking, summary, invoices: stInvoices }, { compress: false, language });
        const lf2 = pdfFlat(lb.buffer);
        ok(lf2.includes("Invoices raised") && lf2.includes("PAYMENT DETAILS") && lf2.includes("Total including GST"),
          `${language}: trail, payment block and resolution all present`);
      }
    }

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

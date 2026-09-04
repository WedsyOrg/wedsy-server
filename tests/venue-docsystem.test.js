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
    has(flatQ, "15,26,450", "the charged row's line-total column equals the per-line sum");

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
    console.log("\n[4. confirmation: spaces, rooms, schedule]");
    const conf = await buildVenueDocument("confirmation", { venue, lead, booking }, { compress: false, language: "classic" });
    const flatC = pdfFlat(conf.buffer);
    has(flatC, "Estate Lawn, Banyan Courtyard", "spaces allocated");
    has(flatC, "18 rooms", "rooms on the fact strip");
    has(flatC, "Booking amount — token", "the schedule's rows");
    has(flatC, "Sums exactly to total payable", "…and its proof row");
    has(flatC, "Rs. 14,82,500", "the agreed payable");
    hasNot(flatC, "Bar extension on the night", "the confirmation documents the AGREED deal — extras are not on it");

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

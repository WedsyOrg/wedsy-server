// MONEY LINES S2 — the charge library and line-mode quote math.
// Run: DATABASE_URL=... node tests/venue-money-lines.test.js
//
// The load-bearing claims, each asserted rather than argued:
//   · CHARGED vs REFUNDABLE: a refundable line is inside the grand total and
//     never inside `charged` — the figure the seam will write into
//     VenueBooking.totalValue.
//   · GST TREATMENT, not rate: none/full/part against the ONE gstPercent, with
//     "part" strictly inside the amount. Rohaan's worked example is pinned.
//   · COPY, NOT REFERENCE: a line picked from a charge stands alone — editing
//     or DELETING the charge moves nothing already quoted. The delete is HARD,
//     deliberately not the amenity retire rule, and the schema assertion below
//     fails the suite if anyone adds isActive "for consistency".
//   · LEGACY IS UNTOUCHED: a qty×unitPrice quote computes byte-identically,
//     and a line quote never silently degrades back to legacy math.
//   · The defect-1 classifier tells inflated from corrected from drifted.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");

const bs = require("../controllers/venueBookingSettings");
const quotes = require("../controllers/venueQuote");
const { computeTotals, computeLineTotals } = require("../utils/venueMoney");
const { DEFAULT_BOOKING_CHARGES, checkChargeMoney, chargeKeyFor } = require("../utils/venueBookingCharges");
const { classifyBooking } = require("../scripts/assess-quote-accept-gst-seam");

const TAG = `mlines-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
      venueMember: null,
    });
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`, stage: "contacted",
    });

    // ══ A. THE MATH — computeLineTotals ═════════════════════════════════════
    console.log("\n[A. line totals: treatment against the one rate, charged vs refundable]");
    // Rohaan's worked example, verbatim from the spec.
    const t1 = computeLineTotals([{ amount: 500000, gstTreatment: "part", taxableAmount: 200000 }], 18);
    eq(t1.gst, 36000, "🔴 SPEC: 5,00,000 with GST on part 2,00,000 @18% → GST 36,000");
    eq(t1.grandTotal, 536000, "…and the line contributes 5,36,000");
    const t2 = computeLineTotals(
      [
        { amount: 500000, gstTreatment: "full", refundable: false },              // venue
        { amount: 200000, gstTreatment: "part", taxableAmount: 50000 },           // decor
        { amount: 25000, gstTreatment: "none", refundable: true },                // security deposit
      ],
      18
    );
    eq(t2.subtotal, 725000, "subtotal is every line, deposit included");
    eq(t2.charged, 700000, "🔴 charged EXCLUDES the refundable line — the figure the seam will write");
    eq(t2.refundable, 25000, "🔴 refundable is its own figure, held and returned");
    eq(t2.taxable, 550000, "taxable = full's amount + part's taxableAmount, none contributes nothing");
    eq(t2.gst, 99000, "GST on the taxable figure only (90,000 + 9,000)");
    eq(t2.grandTotal, 824000, "grand total = everything + GST — what the document shows on top");
    ok(t2.charged + t2.refundable === t2.subtotal, "charged + refundable = subtotal, always");
    // GST rounds PER LINE, so the per-line sentence and the total agree.
    const t3 = computeLineTotals(
      [{ amount: 3, gstTreatment: "full" }, { amount: 3, gstTreatment: "full" }],
      18
    );
    eq(t3.gst, 2, "per-line rounding: round(0.54) × 2 = 2, not round(1.08) = 1");

    // ══ B. THE SHARED VALIDATION — checkChargeMoney ═════════════════════════
    console.log("\n[B. one validation for a settings entry and a quote line]");
    ok(!checkChargeMoney({ amount: 500000, gstTreatment: "part", taxableAmount: 500000 }, "x").ok,
      "🔴 part must be STRICTLY less than the amount — equal is spelled 'full'");
    ok(!checkChargeMoney({ amount: 500000, gstTreatment: "part", taxableAmount: 0 }, "x").ok, "part of nothing is refused");
    ok(!checkChargeMoney({ amount: 500000, gstTreatment: "none", taxableAmount: 1000 }, "x").ok,
      "a taxable amount without 'part' is refused, not ignored");
    ok(!checkChargeMoney({ amount: -1, gstTreatment: "none" }, "x").ok, "negative amounts are refused");
    ok(checkChargeMoney({ amount: 0, gstTreatment: "none" }, "x").ok, "a zero line is legal (an 'included' item)");
    eq(chargeKeyFor("Generator charges"), "generator_charges", "keys derive like amenity keys");

    // ══ C. THE CHARGE LIBRARY — seed + venue-local, amenity-shaped ══════════
    console.log("\n[C. the library: seed, add, collide, edit]");
    let r = await call(bs.listBookingCharges, req());
    eq(r.code, 200, "list answers");
    eq(r.body.charges.length, 0, "a new venue has no charges");
    eq(r.body.suggestions.length, DEFAULT_BOOKING_CHARGES.length, "…and the whole seed as suggestions");
    r = await call(bs.addBookingCharge, req({ body: { seed: true } }));
    eq(r.body.seeded, 4, "🔴 the four seeds land: cleaning, security deposit, generator, lighting");
    ok(r.body.charges.find((c) => c.key === "security_deposit").refundable === true,
      "🔴 the security deposit seeds REFUNDABLE — the whole reason the flag exists");
    ok(r.body.charges.filter((c) => c.refundable).length === 1, "…and it is the only refundable seed");
    r = await call(bs.addBookingCharge, req({ body: { seed: true } }));
    eq(r.body.seeded, 0, "seeding again adds nothing — idempotent");
    r = await call(bs.addBookingCharge, req({ body: { label: "Valet parking", defaultAmount: 15000, gstTreatment: "full" } }));
    eq(r.code, 201, "a custom charge is the owner's to add");
    r = await call(bs.addBookingCharge, req({ body: { label: "valet PARKING" } }));
    eq(r.code, 409, "label collision, case-insensitive (the lossy-key lesson from amenities)");
    r = await call(bs.addBookingCharge, req({ body: { label: "Bad part", defaultAmount: 1000, gstTreatment: "part", taxableAmount: 1000 } }));
    eq(r.code, 400, "settings entries take the same part-bounds rule as lines");
    r = await call(bs.updateBookingCharge, req({ params: { key: "cleaning_charge" }, body: { defaultAmount: 20000, gstTreatment: "full" } }));
    eq(r.code, 200, "edit an entry");
    eq(r.body.charge.defaultAmount, 20000, "…the default moved");
    r = await call(bs.getBookingSettings, req());
    ok(Array.isArray(r.body.bookingCharges) && r.body.bookingCharges.length === 5,
      "the one Settings read carries the charges beside slabs and branding");

    // ══ D. COPY, NOT REFERENCE — the ruled difference from amenities ════════
    console.log("\n[D. a picked line stands alone; delete is HARD, even in use]");
    r = await call(quotes.createQuote, req({
      body: {
        enquiry: String(lead._id),
        gstPercent: 18,
        lineItems: [
          { label: "Venue hire", amount: 500000, gstTreatment: "full" },
          { label: "Cleaning charge", amount: 20000, gstTreatment: "full", source: { chargeKey: "cleaning_charge" } },
          { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true, source: { chargeKey: "security_deposit" } },
        ],
      },
    }));
    eq(r.code, 201, "a line quote files");
    const quoteId = String(r.body.quote._id);
    const lineBefore = r.body.quote.lineItems.find((l) => l.source && l.source.chargeKey === "cleaning_charge");
    eq(lineBefore.amount, 20000, "the line COPIED the charge's value at pick time");

    r = await call(bs.updateBookingCharge, req({ params: { key: "cleaning_charge" }, body: { defaultAmount: 99000 } }));
    eq(r.body.charge.defaultAmount, 99000, "the setting really changed (the fixture could have failed)");
    let q = await VenueQuote.findById(quoteId).lean();
    eq(q.lineItems.find((l) => l.source && l.source.chargeKey === "cleaning_charge").amount, 20000,
      "🔴 RULED: editing the setting NEVER moves a quote already sent");

    r = await call(bs.deleteBookingCharge, req({ params: { key: "cleaning_charge" } }));
    eq(r.code, 200, "delete answers even though a quote uses the charge");
    ok(r.body.deleted === true && !r.body.retired, "🔴 RULED: a HARD delete — no retire verdict, unlike amenities");
    ok(!r.body.charges.find((c) => c.key === "cleaning_charge"), "…gone from the library");
    q = await VenueQuote.findById(quoteId).lean();
    eq(q.lineItems.find((l) => l.source && l.source.chargeKey === "cleaning_charge").amount, 20000,
      "🔴 …and the line on the quote stands exactly as picked");

    // The failing expectation: charges hold COPIES, amenities hold KEY
    // REFERENCES — that is why delete is safe here and retirement was needed
    // there. If someone adds isActive to bookingCharges "for consistency with
    // amenities", this fails and points at the ruling.
    const chargePaths = Venue.schema.path("bookingCharges").schema.paths;
    ok(!("isActive" in chargePaths),
      "🔴 GUARD: bookingCharges has NO isActive — lines are copies, so nothing needs retirement; see the ruling in the model");
    ok("isActive" in Venue.schema.path("roomAmenities").schema.paths,
      "…while roomAmenities keeps its isActive, because rooms hold key references");

    // ══ E. LINE-MODE QUOTES — validation and the legacy boundary ════════════
    console.log("\n[E. line quotes validate as lines; legacy quotes compute as before]");
    eq(q.totals.charged, 520000, "stored totals carry charged (venue + cleaning, both non-refundable)");
    eq(q.totals.refundable, 25000, "…and refundable");
    eq(q.totals.gst, 93600, "GST from the two full lines (90,000 + 3,600), none from the deposit");
    eq(q.totals.grandTotal, 638600, "grand total on top, as the document will show");
    const mirror = q.lineItems[0];
    ok(mirror.qty === 1 && mirror.unitPrice === 500000, "🔴 qty/unitPrice mirror the amount — legacy renderers keep totalling");

    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), lineItems: [{ label: "A", amount: 1000, gstTreatment: "full" }, { label: "B", qty: 2, unitPrice: 500 }] },
    }));
    eq(r.code, 400, "🔴 a payload mixing line-shaped and legacy-shaped rows is refused, not guessed at");
    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), discount: 5000, lineItems: [{ label: "A", amount: 1000, gstTreatment: "none" }] },
    }));
    eq(r.code, 400, "a document discount is refused on a line quote — adjust the line amounts");
    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstMode: "inclusive", lineItems: [{ label: "A", amount: 1000, gstTreatment: "none" }] },
    }));
    eq(r.code, 400, "gstMode does not apply to a line quote — treatment is per line");
    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), lineItems: [{ label: "A", amount: 1000, gstTreatment: "part", taxableAmount: 1000 }] },
    }));
    eq(r.code, 400, "the part-bounds rule holds on the quote path too");

    // Legacy stays legacy, byte-identically.
    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstPercent: 18, discount: 1000, lineItems: [{ label: "Old shape", qty: 2, unitPrice: 50000 }] },
    }));
    eq(r.code, 201, "a legacy quote still files");
    const legacy = r.body.quote;
    const expect = computeTotals([{ qty: 2, unitPrice: 50000 }], 18, 1000, "exclusive");
    eq(legacy.totals.grandTotal, expect.grandTotal, "🔴 legacy math is computeTotals, untouched (discount honoured)");
    eq(legacy.totals.charged, 0, "…and the new totals fields sit at 0, claiming nothing");
    ok(!legacy.lineItems[0].gstTreatment, "…legacy rows carry no treatment");

    // Upgrade is allowed; degrade is refused.
    r = await call(quotes.updateQuote, req({
      params: { quoteId: String(legacy._id) },
      body: { lineItems: [{ label: "Now a line", amount: 100000, gstTreatment: "full" }] },
    }));
    eq(r.code, 200, "a legacy quote upgrades to lines by sending line-shaped items");
    eq(r.body.quote.totals.charged, 100000, "…and computes as lines");
    r = await call(quotes.updateQuote, req({
      params: { quoteId: String(legacy._id) },
      body: { lineItems: [{ label: "Back to old", qty: 1, unitPrice: 5 }] },
    }));
    eq(r.code, 400, "🔴 a line quote never silently degrades — treatments and flags would vanish");
    r = await call(quotes.updateQuote, req({ params: { quoteId: String(legacy._id) }, body: { gstPercent: 5 } }));
    eq(r.code, 200, "changing the one rate on a line quote recomputes");
    eq(r.body.quote.totals.gst, 5000, "…with line math (5% of 1,00,000)");

    // ══ F. THE DEFECT-1 CLASSIFIER — provable without a database ════════════
    console.log("\n[F. the assess script tells inflated from corrected from drifted]");
    const quoteTotals = { gstMode: "exclusive", totals: { grandTotal: 118000, taxable: 100000 } };
    eq(classifyBooking({ totalValue: 118000 }, quoteTotals).verdict, "inflated",
      "🔴 totalValue === grandTotal ≠ taxable → INFLATED (the live seam defect)");
    eq(classifyBooking({ totalValue: 118000 }, quoteTotals).delta, 18000, "…and the delta is the 18% GST");
    eq(classifyBooking({ totalValue: 118000 }, quoteTotals).mode, "exclusive",
      "🔴 the verdict CARRIES THE MODE — exclusive means over-billing…");
    eq(classifyBooking({ totalValue: 50000 }, { gstMode: "inclusive", totals: { grandTotal: 50000, taxable: 47619 } }).mode,
      "inclusive", "…inclusive means an all-in agreement vs the ex-GST declaration, NOT over-billing");
    eq(classifyBooking({ totalValue: 100000 }, quoteTotals).verdict, "matches_taxable", "the ex-GST figure reads as corrected");
    eq(classifyBooking({ totalValue: 110000 }, quoteTotals).verdict, "drifted", "neither figure → drifted (hand-edited)");
    eq(classifyBooking({ totalValue: 50000 }, { totals: { grandTotal: 50000, taxable: 50000 } }).verdict, "no_gst_on_quote",
      "grand === taxable → the seam wrote a correct number");
    eq(classifyBooking({ totalValue: 50000 }, null).verdict, "no_accepted_quote", "no accepted quote → the seam never ran");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueQuote.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();

// WIZARD-QUOTE — confirm names the quote, and the quote IS the money.
// Run: DATABASE_URL=... node tests/venue-wizard-quote.test.js
//
// The road this pins: the wizard's quote step edits the SAME VenueQuote the
// Money tab edits and hands its id to confirm. Until this build, lines
// reached a draft booking only through quote ACCEPTANCE — a wizard-built
// quote had no road onto the booking, and confirm would have treated a
// freshly quoted booking as legacy (no lines, typed total, editable GST).
//
// The load-bearing claims:
//   · confirm with quoteId applies the quote through applyQuoteToBooking —
//     the SAME seam acceptance uses — so the booking gets the lines
//     snapshotted, totalValue = CHARGED, gstPercent copied, gstMode "none".
//   · the schedule is validated against the named quote's COLLECTABLE
//     (charged + refundable + GST — GST-first, wizard2: the schedule carries
//     the GST inside and the tax invoices are cut from payments): the guard
//     that has shipped broken twice runs against the quote the wizard showed.
//   · a draft that ALREADY carries lines (accepted earlier) wins over a
//     stale wizard id — the accepted write is the standing truth.
//   · refusals: an id not on this lead is 404 quote_not_found; a legacy
//     qty×unitPrice quote is 400 quote_not_line_mode; both BEFORE any
//     calendar write, so no booking exists to roll back.
//   · THE SCHEDULE SEEN IS THE SCHEDULE COMMITTED — the stored rows carry
//     the exact amounts the payload stated, behind the server's own Token
//     row. That defect has appeared twice; this is its third-time lock.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");

const quotes = require("../controllers/venueQuote");
const bookings = require("../controllers/venueBooking");

const TAG = `wizq-${Date.now()}`;
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
const nextDate = () => `2095-0${Math.ceil(dayCursor / 28)}-${String(((dayCursor++ - 1) % 28) + 1).padStart(2, "0")}`;
const fn = (date) => [{ date, name: "Wedding", space: String(venue.spaces[0]._id) }];
const confirmLead = (lead, body) =>
  call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(lead._id) }, body }));

/** The wizard's quote step: a saved line quote on the lead, never accepted. */
async function lineQuote(lead, lineItems, gstPercent = 18) {
  const r = await call(quotes.createQuote, req({ body: { enquiry: String(lead._id), gstPercent, lineItems } }));
  if (r.code !== 201) throw new Error(`quote refused: ${JSON.stringify(r.body)}`);
  return r.body.quote;
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, spaces: [{ name: "Hall", isBookable: true }] });
    created.venues.push(venue._id);
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ══ A. THE ROAD: confirm with quoteId, no acceptance, no draft ═════════
    console.log("\n[A. a wizard-saved quote becomes the booking's money at confirm]");
    let lead = await mkLead();
    let quote = await lineQuote(lead, [
      { label: "Venue rental", amount: 500000, gstTreatment: "full" },
      { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
    ]);
    // GST-FIRST: charged 5,00,000 + GST 90,000 + refundable 25,000 =
    // collectable 6,15,000; token 50,000 → the rows cover the 5,65,000
    // balance. Exactly what the wizard sends.
    let r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(quote._id),
      tokenAmount: 50000,
      paymentSchedule: [
        { label: "Advance", amount: 200000, dueDate: "2095-01-01" },
        { label: "Balance", amount: 365000, dueDate: "2095-02-01" },
      ],
    });
    eq(r.code, 200, "🔴 confirm with quoteId succeeds — the quote step's save is a road, not a dead end");
    let bk = await VenueBooking.findById(r.body.booking._id).lean();
    eq(bk.lineItems.length, 2, "🔴 the quote's lines are ON the booking — same seam as acceptance");
    eq(bk.totalValue, 500000, "🔴 totalValue is CHARGED — derived from the lines, the deposit not in it");
    eq(bk.gstPercent, 18, "the quote's one rate rides along");
    eq(bk.gstMode, "none", "🔴 RULING A holds on this road too: gstMode forced none, the lines own the GST");
    const dep = bk.lineItems.find((l) => l.refundable);
    ok(dep && dep.amount === 25000 && dep.gstTreatment === "none",
      "…the refundable line keeps amount, treatment and flag");

    // THE SCHEDULE SEEN IS THE SCHEDULE COMMITTED — third-time lock.
    const stored = bk.paymentSchedule || [];
    eq(stored.length, 3, "stored schedule = server's own Token row + the two rows sent");
    ok(stored[0] && /token/i.test(stored[0].label || "") && stored[0].amount === 50000,
      "🔴 the Token row is the SERVER'S build (the wizard never sends one — it would double-count)");
    ok(stored[0].entries && stored[0].entries.length === 1 && stored[0].entries[0].amount === 50000 && stored[0].entries[0].status === "approved",
      "…and it carries the approved paid entry — the token is money received, not money due");
    eq(stored[1].amount, 200000, "🔴 row 1 stored byte-equal to the payload (2,00,000)");
    eq(stored[2].amount, 365000, "🔴 row 2 stored byte-equal to the payload (3,65,000)");
    eq(stored[1].amount + stored[2].amount + stored[0].amount, 615000,
      "…and token + rows collect exactly the collectable — GST inside (6,15,000)");
    ok(bk.scheduleIncludesGst === true,
      "🔴 the booking carries the GST-first era marker — every later guard reads the right base");

    // ══ B. THE GUARD RUNS AGAINST THE NAMED QUOTE ══════════════════════════
    console.log("\n[B. the schedule is validated against the quote's payable]");
    lead = await mkLead();
    quote = await lineQuote(lead, [
      { label: "Venue rental", amount: 500000, gstTreatment: "full" },
      { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
    ]);
    r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(quote._id),
      tokenAmount: 50000,
      // covers the OLD ex-GST payable — under GST-first that is short by the GST
      paymentSchedule: [{ label: "Balance", amount: 475000 }],
    });
    eq(r.code, 400, "🔴 a schedule short of the collectable is refused");
    eq(r.body.code, "schedule_value_mismatch", "…as schedule_value_mismatch");
    eq(r.body.payable, 615000, "…naming the collectable the lines derive (6,15,000 — GST inside)");
    ok(/GST/.test(r.body.message || ""), "…and the message names the GST the schedule must collect");
    ok(!(await VenueBooking.exists({ enquiry: lead._id, status: { $ne: "draft" } })),
      "…and no confirmed booking exists — refused before the calendar");

    // a booking-level GST mode on this road is the same refusal as ever
    r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(quote._id),
      gstMode: "per_instalment",
      tokenAmount: 50000,
      paymentSchedule: [{ label: "Balance", amount: 565000 }],
    });
    eq(r.code, 400, "a booking-level gstMode alongside quoteId is refused");
    eq(r.body.code, "line_booking_gst", "…as line_booking_gst — the wizard no longer even renders the control");

    // and a stated totalValue disagreeing with the lines is refused likewise
    r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(quote._id),
      totalValue: 999999,
      tokenAmount: 50000,
      paymentSchedule: [{ label: "Balance", amount: 565000 }],
    });
    eq(r.code, 400, "a stated total disagreeing with the named quote's lines is refused");
    eq(r.body.code, "total_is_derived_from_lines", "…as total_is_derived_from_lines");

    // ══ C. REFUSALS: the id must be real, on this lead, and line-mode ══════
    console.log("\n[C. quoteId refusals, all before any write]");
    lead = await mkLead();
    r = await confirmLead(lead, { functions: fn(nextDate()), quoteId: "not-an-id" });
    eq(r.code, 400, "a malformed quoteId is 400");
    r = await confirmLead(lead, { functions: fn(nextDate()), quoteId: String(new mongoose.Types.ObjectId()) });
    eq(r.code, 404, "an id that exists nowhere on this lead is 404");
    eq(r.body.code, "quote_not_found", "…as quote_not_found");
    // a quote on a DIFFERENT lead of the same venue is equally not-found —
    // the scope is {venue, enquiry}, not just existence
    const otherLead = await mkLead();
    const otherQuote = await lineQuote(otherLead, [{ label: "Venue rental", amount: 100000, gstTreatment: "full" }]);
    r = await confirmLead(lead, { functions: fn(nextDate()), quoteId: String(otherQuote._id) });
    eq(r.code, 404, "🔴 another lead's quote is refused — the id is scoped to this enquiry");
    // a LEGACY quote (qty × unitPrice) is not what the wizard's step writes
    const legacyRes = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstPercent: 18, gstMode: "exclusive", lineItems: [{ label: "Venue", qty: 1, unitPrice: 100000 }] },
    }));
    r = await confirmLead(lead, { functions: fn(nextDate()), quoteId: String(legacyRes.body.quote._id) });
    eq(r.code, 400, "a legacy qty×unitPrice quote is refused");
    eq(r.body.code, "quote_not_line_mode", "…as quote_not_line_mode");
    ok(!(await VenueBooking.exists({ enquiry: lead._id })),
      "🔴 none of the refusals left a booking behind — all run before the draft is created");

    // ══ D. A DRAFT WITH LINES WINS OVER A STALE ID ═════════════════════════
    console.log("\n[D. an accepted quote's write beats a stale wizard id]");
    lead = await mkLead();
    // quote 1 accepted — the seam writes its lines onto the draft
    let r1 = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstPercent: 18, lineItems: [{ label: "Venue rental", amount: 300000, gstTreatment: "full" }] },
    }));
    await call(quotes.updateQuote, req({ params: { quoteId: String(r1.body.quote._id) }, body: { status: "accepted" } }));
    // quote 2 — a stale id from a long-open wizard, never accepted
    const stale = await lineQuote(lead, [{ label: "Venue rental", amount: 999000, gstTreatment: "full" }]);
    r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(stale._id),
      paymentSchedule: [{ label: "Full", amount: 354000 }],
    });
    eq(r.code, 200, "confirm succeeds — the schedule matches the DRAFT's lines (with their GST), which stand");
    bk = await VenueBooking.findById(r.body.booking._id).lean();
    eq(bk.totalValue, 300000, "🔴 the accepted quote's 3,00,000 stands; the stale 9,99,000 id changed nothing");
    eq(bk.lineItems.length, 1, "…one line, the accepted one");
    eq(bk.lineItems[0].amount, 300000, "…at the accepted amount");

    // ══ E. PERCENT ROWS COST AGAINST THE QUOTE'S BALANCE ═══════════════════
    console.log("\n[E. the wizard's real shape: token + percent rows against payable − token]");
    lead = await mkLead();
    quote = await lineQuote(lead, [{ label: "Venue rental", amount: 350000, gstTreatment: "full" }]);
    // GST-first spelling of Rohaan's example: Rs. 3,50,000 full-GST @18 →
    // collectable Rs. 4,13,000; Rs. 50,000 token → the rows split the
    // 3,63,000 balance 50/50. The wizard DISPLAYS shares of the collectable;
    // what it SENDS is the engine's remainder percents (identity pinned
    // UI-side, S6).
    r = await confirmLead(lead, {
      functions: fn(nextDate()),
      quoteId: String(quote._id),
      tokenAmount: 50000,
      paymentSchedule: [
        { label: "Second", percent: 50, amount: 181500 },
        { label: "Final", percent: 50, amount: 181500 },
      ],
    });
    eq(r.code, 200, "🔴 the token + 50/50 shape confirms against the quote's payable");
    bk = await VenueBooking.findById(r.body.booking._id).lean();
    const rows = (bk.paymentSchedule || []).filter((row) => !/token/i.test(row.label || ""));
    eq(rows.length, 2, "two instalment rows behind the Token row");
    ok(rows.every((row) => row.amount === 181500),
      "🔴 each stored at 1,81,500 — exactly the split of the collectable the screen showed");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("SUITE ERROR:", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueBooking.deleteMany({ venue: v });
      await VenueQuote.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueOwner.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

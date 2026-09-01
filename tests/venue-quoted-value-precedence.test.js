// THE LINES ARE THE NUMBER — write-through precedence (founder ruling).
// Run: DATABASE_URL=... node tests/venue-quoted-value-precedence.test.js
//
// estimatedValue stays the ONE materialised figure (two OS projections read it
// at the Mongo level and cannot call a helper); what changed is WHO WRITES IT:
//   booking > latest line quote (CHARGED) > latest round with an amount > hand
// Rounds stop writing through the moment a line quote exists — their sync
// calls keep running and the precedence makes them no-ops.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");

const quotes = require("../controllers/venueQuote");
const rounds = require("../controllers/venueQuoteRound");
const { syncQuotedValue } = require("../utils/venueQuotedValue");

const TAG = `qvp-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

let venue;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
  venueMember: null,
});
const mkLead = (extra = {}) => VenueEnquiry.create({
  venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`,
  stage: "negotiating", activities: [], ...extra,
});
const ev = async (lead) => (await VenueEnquiry.findById(lead._id).lean()).estimatedValue;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);

    // ══ A. LEGACY: rounds still write through on a lead with no quote ═══════
    console.log("\n[A. no line quote → the round rule stands, byte-identical]");
    const legacy = await mkLead({ estimatedValue: 0 });
    let r = await call(rounds.createRound, req({ params: { enquiryId: String(legacy._id) }, body: { amount: 700000, sentVia: "call" } }));
    eq(r.code, 201, "round logs");
    eq(await ev(legacy), 700000, "🔴 a lead with no line quote: the round writes through, exactly as shipped");

    // ══ B. THE LINES TAKE OVER ══════════════════════════════════════════════
    console.log("\n[B. a line quote exists → its CHARGED figure rules, rounds go quiet]");
    const lead = await mkLead({ estimatedValue: 0 });
    r = await call(rounds.createRound, req({ params: { enquiryId: String(lead._id) }, body: { amount: 175000, sentVia: "call" } }));
    eq(await ev(lead), 175000, "the pre-quote round writes through first");
    r = await call(quotes.createQuote, req({
      body: {
        enquiry: String(lead._id), gstPercent: 18,
        lineItems: [
          { label: "Venue hire", amount: 200000, gstTreatment: "full" },
          { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
        ],
      },
    }));
    eq(r.code, 201, "line quote files");
    eq(await ev(lead), 200000, "🔴 estimatedValue = CHARGED — the deposit is NOT in the pipeline figure");
    const acts = (await VenueEnquiry.findById(lead._id).lean()).activities;
    ok(acts.some((a) => a.type === "quote_changed" && /as lines/.test(a.description)),
      "…and the move is on the activity trail, like a round-driven move");

    r = await call(rounds.createRound, req({ params: { enquiryId: String(lead._id) }, body: { amount: 150000, clientResponse: "can you do 1.5?", outcome: "countered", sentVia: "call" } }));
    eq(r.code, 201, "a later round still logs — the narrative is not blocked");
    eq(await ev(lead), 200000, "🔴 …but it does NOT move the number: rounds stop writing through once a line quote exists");

    // ══ C. THE QUOTE MOVES, THE NUMBER FOLLOWS ══════════════════════════════
    console.log("\n[C. edits and versions]");
    const q1 = r.body ? null : null;
    const savedQuote = await VenueQuote.findOne({ enquiry: lead._id }).sort({ version: -1 });
    r = await call(quotes.updateQuote, req({
      params: { quoteId: String(savedQuote._id) },
      body: { lineItems: [
        { label: "Venue hire", amount: 180000, gstTreatment: "full" },
        { label: "Security deposit", amount: 25000, gstTreatment: "none", refundable: true },
      ] },
    }));
    eq(r.code, 200, "the draft re-saves");
    eq(await ev(lead), 180000, "editing the lines moves the figure");

    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstPercent: 18, lineItems: [{ label: "Venue hire", amount: 190000, gstTreatment: "full" }] },
    }));
    eq(await ev(lead), 190000, "a NEW version supersedes — the newest line quote rules");

    // Accepted keeps ruling (no backslide to the round while un-booked).
    const v2 = await VenueQuote.findOne({ enquiry: lead._id }).sort({ version: -1 });
    r = await call(quotes.updateQuote, req({ params: { quoteId: String(v2._id) }, body: { status: "accepted" } }));
    eq(r.code, 200, "accepted");
    eq(await ev(lead), 190000, "🔴 acceptance does not drop the figure back to the round");
    await VenueBooking.deleteMany({ enquiry: lead._id });

    // A LEGACY quote superseding the line quote → the lines are gone → rounds rule again.
    const lead2 = await mkLead({ estimatedValue: 0 });
    await call(rounds.createRound, req({ params: { enquiryId: String(lead2._id) }, body: { amount: 111000, sentVia: "call" } }));
    await call(quotes.createQuote, req({ body: { enquiry: String(lead2._id), gstPercent: 18, lineItems: [{ label: "Venue", amount: 300000, gstTreatment: "none" }] } }));
    eq(await ev(lead2), 300000, "line quote rules lead2");
    await call(quotes.createQuote, req({ body: { enquiry: String(lead2._id), gstPercent: 18, lineItems: [{ label: "Old shape", qty: 1, unitPrice: 500000 }] } }));
    eq(await ev(lead2), 111000, "a legacy quote supersedes the line quote → the round rule returns (no line quote left standing)");

    // ══ D. HAND EDITS AND BOOKED LEADS ══════════════════════════════════════
    console.log("\n[D. rule 1 and rule 4]");
    const lead3 = await mkLead({ estimatedValue: 555000 });
    const doc3 = await VenueEnquiry.findById(lead3._id);
    const s3 = await syncQuotedValue(doc3);
    ok(!s3.changed, "a hand-typed figure with nothing authoritative stands (rule 4)");
    const booked = await mkLead({ estimatedValue: 999, stage: "booked" });
    const sB = await syncQuotedValue(await VenueEnquiry.findById(booked._id));
    ok(!sB.changed && sB.source === "booking", "a booked lead is never touched (rule 1)");

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

// Requirements as yes / no / NOT ASKED, plus special requests.
// Run: node tests/venue-lead-requirements.test.js
//
// "Not asked" and "no" are different facts, and the old shape could not tell
// them apart: an empty string meant both "nobody has asked" and "they don't
// want it". This suite pins the three things that would quietly break a real
// book: a lead answered before `asks` existed must still read correctly (no
// migration ran), answering one question must not wipe the others, and a note
// must not survive the yes it was attached to.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");

const ctrl = require("../controllers/venueEnquiry");

const TAG = `req-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(ownerDoc._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: ownerDoc._id },
      venueMember: null,
    });
    const mkLead = (extra = {}) => VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} ${extra.n || "L"}`,
      couplePhone: `9${Date.now()}`.slice(0, 10), stage: "contacted", ...extra,
    });
    const readAsks = async (id) => {
      const res = await call(ctrl.getEnquiryById, req({ params: { enquiryId: String(id) } }));
      return res.body.enquiry.requirements.asks;
    };
    const patchReq = (id, requirements) =>
      call(ctrl.updateEnquiry, req({ params: { enquiryId: String(id) }, body: { requirements } }));

    // ── the three states are actually three ──
    console.log("\n[A. not asked, no, and yes are three different answers]");
    const fresh = await mkLead({ n: "Fresh" });
    let asks = await readAsks(fresh._id);
    ok(asks.catering.answer === "" && asks.alcohol.answer === "",
      "a brand-new lead is NOT ASKED on everything — not 'no'");

    await patchReq(fresh._id, { asks: { alcohol: { answer: "no" } } });
    asks = await readAsks(fresh._id);
    ok(asks.alcohol.answer === "no", "'no' is recordable and stays 'no'");
    ok(asks.catering.answer === "", "…and the questions nobody asked are still unasked");

    // ── a note belongs to a yes ──
    console.log("\n[B. a note belongs to the YES it was given for]");
    await patchReq(fresh._id, { asks: { catering: { answer: "yes", note: "Veg only, no onion garlic" } } });
    asks = await readAsks(fresh._id);
    ok(asks.catering.answer === "yes" && /no onion garlic/.test(asks.catering.note),
      "a yes carries the detail the owner actually wrote down");

    await patchReq(fresh._id, { asks: { catering: { answer: "no" } } });
    asks = await readAsks(fresh._id);
    ok(asks.catering.answer === "no" && asks.catering.note === "",
      "THE POINT: changing it to 'no' drops the note — 'veg only' must not hang off a question they said no to");

    // ── one answer must not wipe the others ──
    console.log("\n[C. answering one question does not wipe the rest]");
    await patchReq(fresh._id, { asks: { decor: { answer: "yes", note: "Mandap in the lawn" } } });
    asks = await readAsks(fresh._id);
    ok(asks.decor.answer === "yes", "décor is answered");
    ok(asks.alcohol.answer === "no", "…and the alcohol answer from earlier SURVIVES");
    ok(asks.catering.answer === "no", "…as does catering — a partial PATCH merges per question");

    // ── validation ──
    console.log("\n[D. an answer we cannot store is refused]");
    const bad = await patchReq(fresh._id, { asks: { catering: { answer: "maybe" } } });
    ok(bad.code === 400, "'maybe' → 400");
    ok(/yes, no/.test(bad.body.message || ""), "…and the message says what is allowed");
    const badShape = await patchReq(fresh._id, { asks: { catering: "yes" } });
    ok(badShape.code === 400, "a bare string where an object belongs → 400");

    // ── NO MIGRATION: a lead answered the old way still reads right ──
    console.log("\n[E. a lead answered BEFORE this shape existed — no migration ran]");
    const legacy = await mkLead({
      n: "Legacy",
      requirements: { food: "veg", catering: "inhouse", alcohol: false, decorNotes: "Marigold only", roomsNeeded: 20 },
    });
    asks = await readAsks(legacy._id);
    // FOOD AND CATERING ARE NOW ONE QUESTION. A lead that answered both keeps
    // BOTH details, joined — nothing a human typed is dropped to tidy a merge.
    ok(asks.food === undefined, "`food` is no longer asked separately");
    ok(asks.catering.answer === "yes" && /In-house/.test(asks.catering.note) && /Veg only/.test(asks.catering.note),
      "…both stored details survive as one catering answer");
    ok(asks.alcohol.answer === "no",
      "…a stored alcohol:false reads as NO, because that is the one question the old shape could answer both ways");
    ok(asks.decor.answer === "yes" && asks.decor.note === "Marigold only", "…and décor notes read as a yes with the note");
    const rawLegacy = await VenueEnquiry.findById(legacy._id).lean();
    ok(rawLegacy.requirements.food === "veg", "…and NOTHING was rewritten on disk — the derivation is on read");

    // an explicit answer overrides what was derived
    await patchReq(legacy._id, { asks: { catering: { answer: "no" } } });
    asks = await readAsks(legacy._id);
    ok(asks.catering.answer === "no", "an explicit answer WINS over the derived one — one answer on screen, never two");

    // ── rooms is untouched by all of this ──
    ok((await VenueEnquiry.findById(legacy._id).lean()).requirements.roomsNeeded === 20,
      "rooms to stay is a count, not a yes/no, and is unaffected");

    // ── special requests ──
    console.log("\n[F. special requests — the sentence that loses a booking]");
    const sr = await patchReq(fresh._id, {
      specialRequests: "Bride's grandmother uses a wheelchair — ramp to the mandap.",
    });
    ok(sr.code === 200, "free text saves → 200");
    const stored = await VenueEnquiry.findById(fresh._id).lean();
    ok(/wheelchair/.test(stored.requirements.specialRequests), "…verbatim, not parsed into a box");
    await patchReq(fresh._id, { specialRequests: "" });
    ok((await VenueEnquiry.findById(fresh._id).lean()).requirements.specialRequests === "", "…and can be cleared");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

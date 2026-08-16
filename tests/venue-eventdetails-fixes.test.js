// FIVE FIXES — the function vocabulary, food→catering, and accommodation.
// Run: node tests/venue-eventdetails-fixes.test.js
//
// Three things here could quietly destroy real data, and each has its own
// section: extending an enum must not invalidate what is already stored,
// retiring the `food` question must not throw away what anyone recorded under
// it, and the accommodation yes/no must never disagree with the roomsNeeded
// number that the allotment planner and the booking handoff actually read.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");

const ctrl = require("../controllers/venueEnquiry");
const { FUNCTION_VOCABULARY, ALL_FUNCTION_NAMES, functionAllowed } = require("../utils/venueEventType");

const TAG = `edfix-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }],
    });
    created.venues.push(venue._id);
    const space = (await Venue.findById(venue._id).lean()).spaces[0]._id;
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
      couplePhone: `9${Date.now()}`.slice(0, 10), stage: "contacted",
      checkIn: new Date("2027-06-10T04:00:00Z"), checkOut: new Date("2027-06-12T12:00:00Z"),
      ...extra,
    });
    const readAsks = async (id) => {
      const res = await call(ctrl.getEnquiryById, req({ params: { enquiryId: String(id) } }));
      return res.body.enquiry.requirements.asks;
    };
    const patchReq = (id, requirements) =>
      call(ctrl.updateEnquiry, req({ params: { enquiryId: String(id) }, body: { requirements } }));

    // ── 3. the function vocabulary ──
    console.log("\n[3. the function list grows — and nothing already stored breaks]");
    for (const legacy of ["mehendi", "haldi", "sangeet", "wedding", "reception", "custom"]) {
      ok(functionAllowed("social", legacy), `the pre-existing "${legacy}" still validates`);
    }
    for (const added of ["baraat", "varmala", "nikah", "shukrana", "baby_shower", "anniversary", "engagement"]) {
      ok(functionAllowed("social", added), `"${added}" is now offered`);
    }
    ok(!functionAllowed("social", "conference"), "a corporate session is still refused on a social lead");
    ok(FUNCTION_VOCABULARY.corporate.join(",") === "conference,dinner,cocktail,ceremony,custom",
      "the corporate vocabulary is UNCHANGED");
    ok(ALL_FUNCTION_NAMES.includes("nikah") && ALL_FUNCTION_NAMES.includes("mehendi"),
      "the model's stored-value enum spans old and new");

    const fnLead = await mkLead({ n: "Fns" });
    const wrote = await call(ctrl.updateEnquiry, req({
      params: { enquiryId: String(fnLead._id) },
      body: {
        functions: [
          { name: "nikah", date: "2027-06-10", timeSlot: "11:00 AM", space: String(space) },
          { name: "shukrana", date: "2027-06-11", timeSlot: "10:00 AM", space: String(space) },
          { name: "baraat", date: "2027-06-11", timeSlot: "5:00 PM", space: String(space) },
          { name: "custom", customLabel: "Griha Pravesh", date: "2027-06-12", timeSlot: "9:00 AM", space: String(space) },
        ],
      },
    }));
    ok(wrote.code === 200, "a lead can be saved with nikah + shukrana + baraat + custom → 200");
    const savedFns = (await VenueEnquiry.findById(fnLead._id).lean()).functions.map((f) => f.name);
    ok(savedFns.includes("nikah") && savedFns.includes("shukrana"),
      "…THE POINT: Muslim and Sikh functions are bookable without inventing a religion field");

    // ── 4. food and catering were one question ──
    console.log("\n[4. food folds into catering — nothing a human typed is lost]");
    const bothSet = await mkLead({ n: "Both", requirements: { food: "veg", catering: "inhouse" } });
    let asks = await readAsks(bothSet._id);
    ok(asks.food === undefined, "`food` is no longer a question of its own");
    ok(asks.catering.answer === "yes", "a lead carrying BOTH reads as one catering yes");
    ok(/In-house/.test(asks.catering.note) && /Veg only/.test(asks.catering.note),
      "…and BOTH details survive the merge — 'In-house · Veg only'");

    const foodOnly = await mkLead({ n: "FoodOnly", requirements: { food: "nonveg" } });
    ok((await readAsks(foodOnly._id)).catering.note === "Non-veg",
      "a lead that only ever answered food still reads as a catering yes");

    // Written by the PREVIOUS deploy, straight to the document — the state a
    // real lead is in today.
    const askFoodOnly = await mkLead({ n: "AskFood" });
    await VenueEnquiry.updateOne({ _id: askFoodOnly._id }, { $set: { "requirements.asks.food": { answer: "no", note: "" } } });
    ok((await readAsks(askFoodOnly._id)).catering.answer === "no",
      "a 'no' already stored under the retired asks.food is adopted as the catering answer");

    // And a stale tab that still SENDS the old question does not lose it.
    const staleTab = await mkLead({ n: "Stale" });
    await patchReq(staleTab._id, { asks: { food: { answer: "yes", note: "Jain food for 40" } } });
    const staleAsks = await readAsks(staleTab._id);
    ok(staleAsks.catering.answer === "yes" && /Jain/.test(staleAsks.catering.note),
      "a late PATCH of the retired question is folded into catering, not dropped");

    const conflict = await mkLead({ n: "Conflict" });
    await patchReq(conflict._id, { asks: { catering: { answer: "yes", note: "Outside caterer approved" } } });
    await patchReq(conflict._id, { asks: { food: { answer: "no" } } });
    ok((await readAsks(conflict._id)).catering.answer === "yes",
      "when the two disagree, YES wins — dropping a recorded requirement is worse than a stale one");

    // ── 5. accommodation, without breaking the rooms handoff ──
    console.log("\n[5. accommodation — and the number the planner reads]");
    const acc = await mkLead({ n: "Acc" });
    ok((await readAsks(acc._id)).accommodation.answer === "", "a fresh lead has NOT been asked");

    const legacyRooms = await mkLead({ n: "Rooms", requirements: { roomsNeeded: 20 } });
    ok((await readAsks(legacyRooms._id)).accommodation.answer === "yes",
      "a lead that recorded 20 rooms reads as YES — it said so by having a number");

    await patchReq(acc._id, { asks: { accommodation: { answer: "yes" } }, roomsNeeded: 35 });
    const accDoc = await VenueEnquiry.findById(acc._id).lean();
    ok(accDoc.requirements.roomsNeeded === 35,
      "THE HANDOFF: answering yes with a number writes requirements.roomsNeeded — the field the allotment planner reads");
    ok((await readAsks(acc._id)).accommodation.answer === "yes", "…and the ask reads yes");

    await patchReq(acc._id, { asks: { accommodation: { answer: "no" } } });
    const afterNo = await VenueEnquiry.findById(acc._id).lean();
    ok(afterNo.requirements.roomsNeeded === 0,
      "THE POINT: answering NO zeroes roomsNeeded — the planner must never still hold 35 rooms for a lead that said no");
    ok((await readAsks(acc._id)).accommodation.answer === "no", "…and it reads back as no, not as 'not asked'");

    // the booking handoff's own expression of the same field
    ok(((await VenueEnquiry.findById(legacyRooms._id).lean()).requirements.roomsNeeded || 0) === 20,
      "an untouched lead's room count is exactly as it was — no migration ran");

    // ── the counter ──
    console.log("\n[the checklist counts each question once]");
    const counted = await mkLead({ n: "Count" });
    await patchReq(counted._id, {
      asks: {
        catering: { answer: "yes", note: "Ours" },
        alcohol: { answer: "no" },
        decor: { answer: "yes", note: "Marigold" },
        accommodation: { answer: "no" },
      },
    });
    asks = await readAsks(counted._id);
    ok(Object.keys(asks).length === 4, "four questions, not five — food is not asked twice under another name");
    ok(Object.values(asks).every((a) => a.answer), "…and all four can be fully answered");

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

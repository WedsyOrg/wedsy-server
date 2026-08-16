// The couple's own community calendar, on the lead.
// Run: node tests/venue-lead-traditions.test.js
//
// TRADITION IS NOT REGION and it is not a single choice. A mixed wedding is two
// traditions, not a compromise between them — see utils/weddingTraditions.js.
// This suite pins the three things that could quietly go wrong: an unknown
// token being swallowed instead of refused, the field not being additive to
// leads written before it existed, and the lead's traditions not actually
// reaching the date advice (which is the entire reason to collect them).
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const AuspiciousDate = require("../models/AuspiciousDate");

const ctrl = require("../controllers/venueEnquiry");
const { resolveBlock } = require("../utils/weddingCalendar");
const { venueDateKey } = require("../utils/venueTime");

const TAG = `trad-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], dates: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, state: "Karnataka", city: "Bangalore" });
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

    // ── additive ──
    console.log("\n[A. additive to every lead written before it existed]");
    const old = await mkLead({ n: "Old" });
    const reread = await VenueEnquiry.findById(old._id).lean();
    ok(Array.isArray(reread.traditions) && reread.traditions.length === 0,
      "a lead created without traditions has [] — 'nobody asked', not a guess");

    // ── validation ──
    console.log("\n[B. an unknown tradition is refused, never swallowed]");
    const bad = await call(ctrl.updateEnquiry, req({ params: { enquiryId: String(old._id) }, body: { traditions: ["bengali"] } }));
    ok(bad.code === 400, "an unknown token → 400");
    ok(/bengali/.test(bad.body.message || ""), "…and the message names it, so the owner knows what was rejected");
    ok((await VenueEnquiry.findById(old._id).lean()).traditions.length === 0, "…and nothing was stored");

    const notArray = await call(ctrl.updateEnquiry, req({ params: { enquiryId: String(old._id) }, body: { traditions: "punjabi" } }));
    ok(notArray.code === 400, "a bare string is refused — the field is multi by design");

    // ── multi, because mixed weddings are real ──
    console.log("\n[C. MIXED — two traditions, not a compromise between them]");
    const mixed = await call(ctrl.updateEnquiry, req({
      params: { enquiryId: String(old._id) }, body: { traditions: ["punjabi", "tamil"] },
    }));
    ok(mixed.code === 200, "a Punjabi-Tamil wedding saves both → 200");
    const both = await VenueEnquiry.findById(old._id).lean();
    ok(both.traditions.length === 2 && both.traditions.includes("punjabi") && both.traditions.includes("tamil"),
      "…and both survive — neither family's calendar is dropped");
    ok(both.activities.some((a) => /Tradition set to/.test(a.description || "")),
      "…and the change is on the timeline: it changes which dates read as auspicious");

    // ── de-dup, and clearing ──
    const dup = await call(ctrl.updateEnquiry, req({ params: { enquiryId: String(old._id) }, body: { traditions: ["punjabi", "punjabi"] } }));
    ok(dup.code === 200 && (await VenueEnquiry.findById(old._id).lean()).traditions.length === 1, "duplicates collapse");

    const clear = await call(ctrl.updateEnquiry, req({ params: { enquiryId: String(old._id) }, body: { traditions: [] } }));
    ok(clear.code === 200 && (await VenueEnquiry.findById(old._id).lean()).traditions.length === 0,
      "[] clears it back to 'nobody asked'");

    // ── THE POINT: it reaches the advice ──
    console.log("\n[D. THE POINT — the couple's tradition narrows the date advice]");
    const day = new Date(Date.now() + 60 * 86400000);
    const key = venueDateKey(day);
    await AuspiciousDate.updateOne(
      { date: key, region: null },
      { $set: { date: key, region: null, traditions: ["tamil"], tier: "good", verified: true, notes: `${TAG}` } },
      { upsert: true }
    );
    created.dates.push(key);

    const tamilBlock = await resolveBlock({ venue, dayKeys: [key], traditions: ["tamil"] });
    const punjabiBlock = await resolveBlock({ venue, dayKeys: [key], traditions: ["punjabi"] });
    const anyBlock = await resolveBlock({ venue, dayKeys: [key], traditions: [] });

    const auspiciousIn = (b) => Boolean(b && b.days && b.days[0] && b.days[0].auspicious);
    ok(auspiciousIn(tamilBlock), "a Tamil-tagged date IS auspicious for a Tamil couple");
    ok(!auspiciousIn(punjabiBlock), "…and is NOT surfaced to a Punjabi couple — that is the whole point of asking");
    ok(auspiciousIn(anyBlock), "…while a couple who was never asked still sees it: unspecified means 'applies unless we learn otherwise'");

    // ── corporate keeps whatever it was told ──
    console.log("\n[E. a lead retyped as corporate keeps what it was told]");
    const corp = await mkLead({ n: "Corp", eventType: "social", traditions: ["gujarati"] });
    const flip = await call(ctrl.updateEnquiry, req({ params: { enquiryId: String(corp._id) }, body: { eventType: "corporate" } }));
    ok(flip.code === 200, "switching to corporate → 200");
    ok((await VenueEnquiry.findById(corp._id).lean()).traditions.includes("gujarati"),
      "…and the tradition is NOT silently wiped — the UI hides it, the data keeps it until a human clears it");

    // ── the vocabulary travels with the lead ──
    console.log("\n[F. the portal is TOLD the vocabulary, it does not keep a copy]");
    const read = await call(ctrl.getEnquiryById, req({ params: { enquiryId: String(corp._id) } }));
    const opts = read.body && read.body.enquiry && read.body.enquiry.traditionOptions;
    ok(Array.isArray(opts) && opts.length === 2, "the lead read carries the two parent traditions");
    ok(opts.every((o) => o.label && Array.isArray(o.children) && o.children.length),
      "…each labelled, with its children — so the frontend never hardcodes a list that can drift");
    ok(opts.flatMap((o) => o.children).some((c) => c.value === "tamil"),
      "…and a sub-tradition the date data can actually be tagged with is offered");

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
    await AuspiciousDate.deleteMany({ notes: TAG });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

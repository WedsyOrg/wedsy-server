// BUILD — the site-visit OUTCOME. Run: node tests/venue-visit-outcome.test.js
//
// `status` is lifecycle (did the appointment happen); `outcome` is how it WENT.
// They are not points on one scale, which is why "no-show" and "too expensive"
// had nowhere to live. These fields are ADDITIVE — a visit written before them
// must keep behaving exactly as it did.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueSiteVisit = require("../models/VenueSiteVisit");
const VenueOwner = require("../models/VenueOwner");

const sv = require("../controllers/venueSiteVisits");

const TAG = `venue-vo-${Date.now()}`;
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
      params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: ownerDoc._id }, venueMember: null,
    });
    const mkLead = (n) => VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} ${n}`, couplePhone: `9${Date.now()}`.slice(0, 10), stage: "contacted" });

    // ── additive: an old-shaped visit still works ──
    console.log("\n[A. the new fields are additive]");
    const legacyLead = await mkLead("Legacy");
    const legacy = await VenueSiteVisit.create({
      venue: venue._id, enquiryRef: legacyLead._id, scheduledAt: new Date(Date.now() + 86400000),
      status: "scheduled", notes: "old shape", createdByType: "owner",
    });
    const reread = await VenueSiteVisit.findById(legacy._id).lean();
    ok(reread.notes === "old shape", "a visit written without the new fields saves and reads back unchanged");
    ok(reread.outcome === null, "…its outcome is null — the honest 'nobody has said' state");
    ok(reread.prepNote === "", "…and its prep note is empty, not undefined");

    // ── prep note at creation ──
    console.log("\n[B. prep note — written BEFORE they walk in]");
    const lead = await mkLead("Prep");
    const mk = await call(sv.createOwnSiteVisit, req({
      body: { leadId: String(lead._id), scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(), prepNote: "Mother-in-law is coming. Have the lawn lit." },
    }));
    ok(mk.code === 201, "create with a prep note → 201");
    const visitId = String(mk.body.visit._id);
    ok((await VenueSiteVisit.findById(visitId).lean()).prepNote.startsWith("Mother-in-law"), "…and it is stored");

    // ── outcome ──
    console.log("\n[C. outcome — the thing that actually matters]");
    const bad = await call(sv.updateOwnSiteVisit, req({ params: { visitId }, body: { outcome: "vibes" } }));
    ok(bad.code === 400, "an unknown outcome is refused, not stored");

    const good = await call(sv.updateOwnSiteVisit, req({
      params: { visitId }, body: { outcome: "too_expensive", outcomeNote: "Loved it, said the quote is 20% over." },
    }));
    ok(good.code === 200, "logging an outcome → 200");
    const done = await VenueSiteVisit.findById(visitId).lean();
    ok(done.outcome === "too_expensive", "…the outcome is stored");
    ok(done.outcomeNote.includes("20%"), "…with the owner's own words");
    ok(Boolean(done.outcomeAt), "…and when it was logged");
    ok(done.status === "completed", "THE POINT: logging an outcome completes the visit — one tap, not two");
    ok((await VenueEnquiry.findById(lead._id).lean()).activities.some((a) => a.type === "site_visit_outcome"),
      "…and it lands on the lead's timeline");

    // ── a no-show is still a finished appointment ──
    console.log("\n[D. a no-show finished too — it just went badly]");
    const lead2 = await mkLead("NoShow");
    const mk2 = await call(sv.createOwnSiteVisit, req({ body: { leadId: String(lead2._id), scheduledAt: new Date(Date.now() + 86400000).toISOString() } }));
    const v2 = String(mk2.body.visit._id);
    await call(sv.updateOwnSiteVisit, req({ params: { visitId: v2 }, body: { outcome: "no_show" } }));
    const ns = await VenueSiteVisit.findById(v2).lean();
    ok(ns.outcome === "no_show" && ns.status === "completed",
      "a no-show is recorded as an outcome and the appointment is closed — it is over either way");

    // ── clearing ──
    console.log("\n[E. an outcome logged in error can be taken back]");
    const cleared = await call(sv.updateOwnSiteVisit, req({ params: { visitId: v2 }, body: { outcome: null } }));
    ok(cleared.code === 200 && (await VenueSiteVisit.findById(v2).lean()).outcome === null,
      "outcome:null clears it (the status stays where it was — undoing a note is not un-happening a visit)");

    // ── nothing-to-update still guarded ──
    const nothing = await call(sv.updateOwnSiteVisit, req({ params: { visitId: v2 }, body: {} }));
    ok(nothing.code === 400, "an empty PATCH is still refused");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueSiteVisit.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

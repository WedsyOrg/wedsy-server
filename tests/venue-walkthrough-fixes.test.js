// Four bugs from a live walkthrough — root-cause coverage.
// Run: node tests/venue-walkthrough-fixes.test.js
//
//   1. Hold expiry could outlive the date it protects, and holds could be
//      raised on dates already gone.
//   2. Hold events were written into notes[] AND activities[] and the lead
//      timeline merges both — every hold rendered twice at one timestamp.
//   4. createManualLead read req.venueOwner.memberId, undefined for an owner
//      token, so owner-created leads landed unassigned.
//
// (3 is a pure UI formatting fix; its coverage is the shared helper's own
// unit assertions plus the browser drive.)
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");

const cal = require("../controllers/venueCalendar");
const enq = require("../controllers/venueEnquiry");
const holdExpiry = require("../utils/venueHoldExpiry");
const { ensureOwnerMember } = require("../utils/venueOwnerMember");

const TAG = `wt-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [], owners: [] };

const dayStr = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const asDate = (s) => new Date(`${s}T00:00:00Z`);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      spaces: [{ name: "Lawn", isBookable: true }],
      settings: { holdExpiryDays: 5 },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ name: `${TAG} Owner`, phone: `${TAG}-own`, venueId: venue._id, role: "owner" });
    created.owners.push(owner._id);
    const ownerMemberId = await ensureOwnerMember(venue._id, owner._id);

    const ownerReq = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, role: "owner" },
      venueMember: null,
    });

    // ══ FIX 1 — hold expiry ═══════════════════════════════════════════════
    console.log("\n[fix 1 · the expiry rule, in isolation]");
    const now = new Date("2026-08-14T12:00:00Z");

    // The common case is UNCHANGED: a far-out date still expires N days out.
    const far = holdExpiry.resolveHoldExpiry([asDate("2026-09-30")], venue, now);
    ok(far.ok && far.expiresAt.toISOString().slice(0, 10) === "2026-08-19", "a far-out date still expires 5 days from REQUEST (unchanged)");
    ok(far.clamped === false, "…and is not clamped");
    ok(far.holdDays === 5, "…using the venue's configured window");

    // THE BUG: expiry could land after the event.
    const late = holdExpiry.resolveHoldExpiry([asDate("2026-08-16")], venue, now);
    ok(late.ok, "a date 2 days out is still holdable");
    ok(late.clamped === true, "THE FIX: 5 days from request would outlive it, so it is CLAMPED");
    ok(late.expiresAt.toISOString().slice(0, 10) === "2026-08-16", "…to the held date itself");
    ok(late.expiresAt.getTime() > now.getTime(), "…and still in the future, so the hold is live");
    ok(late.expiresAt.toISOString().includes("23:59:59"), "…to the END of that day, not its midnight start");

    // Multi-day: the EARLIEST day is the ceiling.
    const multi = holdExpiry.resolveHoldExpiry([asDate("2026-08-18"), asDate("2026-08-16")], venue, now);
    ok(multi.expiresAt.toISOString().slice(0, 10) === "2026-08-16", "a multi-day hold clamps to its EARLIEST day, not its latest");

    // THE FLOOR: a date already gone.
    const past = holdExpiry.resolveHoldExpiry([asDate("2026-08-01")], venue, now);
    ok(!past.ok, "a date already past is REFUSED, not created expired");
    ok(/already passed/i.test(past.message), "…with a message that says why");
    const today = holdExpiry.resolveHoldExpiry([asDate("2026-08-14")], venue, now);
    ok(today.ok && today.clamped, "today is still holdable — until the end of today");

    ok(holdExpiry.holdDaysFor({ settings: {} }) === 5, "a venue with no setting gets the 5-day default");
    ok(holdExpiry.holdDaysFor({ settings: { holdExpiryDays: 0 } }) === 5, "…and a nonsense 0 falls back rather than expiring instantly");
    ok(holdExpiry.holdDaysFor({ settings: { holdExpiryDays: 900 } }) === 60, "…and an absurd value is capped");

    console.log("\n[fix 1 · through the real route]");
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Lead`, coupleNameManual: true,
      couplePhone: "9500000001", stage: "contacted",
    });
    const okHold = await call(cal.createHold, ownerReq({ body: { dates: [dayStr(45)], linkedEnquiry: String(lead._id) } }));
    ok(okHold.code === 201, "createHold on a far date → 201");
    const h1 = await VenueHold.findOne({ venue: venue._id }).sort({ createdAt: -1 }).lean();
    ok(h1.expiresAt > new Date(), "…expiry is in the FUTURE");
    ok(h1.expiresAt <= new Date(`${dayStr(45)}T23:59:59.999Z`), "…and never after the date it protects");

    const nearHold = await call(cal.createHold, ownerReq({ body: { dates: [dayStr(2)] } }));
    ok(nearHold.code === 201, "createHold on a date 2 days out → 201");
    const h2 = await VenueHold.findOne({ venue: venue._id }).sort({ createdAt: -1 }).lean();
    ok(h2.expiresAt.toISOString().slice(0, 10) === dayStr(2), "…clamped to that date rather than 5 days past it");

    const pastHold = await call(cal.createHold, ownerReq({ body: { dates: [dayStr(-3)] } }));
    ok(pastHold.code === 400, "createHold on a PAST date → 400");
    ok((await VenueHold.countDocuments({ venue: venue._id, dates: asDate(dayStr(-3)) })) === 0, "…and no hold row was written");

    // ══ FIX 2 — the double-write ══════════════════════════════════════════
    console.log("\n[fix 2 · one event, one timeline row]");
    const dupLead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Dup`, coupleNameManual: true,
      couplePhone: "9500000002", stage: "contacted",
    });
    const notesBefore = (await VenueEnquiry.findById(dupLead._id).lean()).notes.length;

    const dh = await call(cal.createHold, ownerReq({ body: { dates: [dayStr(30)], linkedEnquiry: String(dupLead._id) } }));
    ok(dh.code === 201, "hold with a linked lead → 201");

    const after = await VenueEnquiry.findById(dupLead._id).lean();
    const holdActivities = after.activities.filter((a) => a.type === "hold_requested");
    ok(holdActivities.length === 1, `exactly ONE hold_requested activity (got ${holdActivities.length})`);
    ok(after.notes.length === notesBefore, "THE FIX: nothing was written to notes[] — a hold is not a hand-typed note");
    // The timeline merges notes + activities, so one row in each was two on screen.
    const timelineRows = [...after.notes, ...after.activities].filter((r) =>
      /Hold requested/i.test(r.text || r.description || "")
    );
    ok(timelineRows.length === 1, "…so the merged timeline shows it exactly once");

    // The new copy explains itself.
    ok(/to confirm/i.test(holdActivities[0].description), "the sentence now says what the expiry MEANS");
    ok(!/— expires \d{4}-\d{2}-\d{2}\.$/.test(holdActivities[0].description), "…not two bare dates side by side");

    // Approve + release must be single-row too.
    const holdId = String(dh.body.hold ? dh.body.hold._id : (await VenueHold.findOne({ linkedEnquiry: dupLead._id }).lean())._id);
    const appr = await call(cal.approveHold, ownerReq({ params: { holdId } }));
    ok(appr.code === 200, "approve → 200");
    const after2 = await VenueEnquiry.findById(dupLead._id).lean();
    ok(after2.notes.length === notesBefore, "…approve wrote no note either");
    ok(after2.activities.filter((a) => a.type === "hold_approved").length === 1, "…exactly one hold_approved activity");

    // ══ FIX 4 — the assignment default ════════════════════════════════════
    console.log("\n[fix 4 · an owner-created lead lands assigned]");
    const asOwner = await call(enq.createManualLead, ownerReq({
      body: { coupleName: `${TAG} ByOwner`, couplePhone: "9500000010" },
    }));
    ok(asOwner.code === 201, "owner creates a lead → 201");
    ok(Boolean(asOwner.body.enquiry.assignedTo), "THE FIX: it is ASSIGNED, not unassigned");
    ok(String(asOwner.body.enquiry.assignedTo) === String(ownerMemberId), "…to the owner's own member row");
    const ownerLead = await VenueEnquiry.findById(asOwner.body.enquiry._id).lean();
    ok(ownerLead.activities.some((a) => a.via === "create_self"), "…via create_self, so the timeline says why");

    // A member creating still behaves exactly as before.
    const bundle = await VenueRole.create({ venue: venue._id, name: `${TAG}-sales`, capabilities: ["leads"] });
    const member = await VenueTeamMember.create({ venueId: venue._id, name: `${TAG}-m`, phone: `${TAG}m`, role: "sales", roleRef: bundle._id, isActive: true });
    const memberReq = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) }, query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: "sales" },
      venueMember: member,
    });
    const asMember = await call(enq.createManualLead, memberReq({ body: { coupleName: `${TAG} ByMember`, couplePhone: "9500000011" } }));
    ok(asMember.code === 201 && String(asMember.body.enquiry.assignedTo) === String(member._id), "a member's create still defaults to that member (unchanged)");

    // An explicit assignee still wins over the creator default.
    const explicit = await call(enq.createManualLead, ownerReq({
      body: { coupleName: `${TAG} Explicit`, couplePhone: "9500000012", assignedTo: String(member._id) },
    }));
    ok(String(explicit.body.enquiry.assignedTo) === String(member._id), "an explicit assignee still wins over the creator default");

    // The public intake path must NOT be changed — a couple filling in a form
    // has no venue-side creator to own the lead.
    const publicReq = { params: { slug: venue.slug }, query: {}, body: { name: `${TAG} Public`, phone: "9500000013" } };
    const pub = await call(enq.createEnquiry, publicReq);
    ok(pub.code === 201, "the public intake still works");
    const pubLead = await VenueEnquiry.findById(pub.body.enquiryId).lean();
    ok(!pubLead.assignedTo, "…and stays unassigned with auto-assign off (unchanged — no creator exists)");

    // ══ FIX 3 — the two money formatters must not drift ══════════════════
    console.log("\n[fix 3 · server prose and client UI format money identically]");
    // The pricing advice is composed into prose SERVER-side and cannot call the
    // client helper, so utils/venuePricingIntel.shortINR is a hand-kept mirror
    // of formatINRShort in wedsy-venue's crm.ts. This is what stops it drifting
    // — and it HAD already drifted: at 999,999 the server said "₹10.0L" while
    // the client said "₹10L".
    const { shortINR } = require("../utils/venuePricingIntel");
    // Transcribed from app/(portal)/crm/_lib/crm.ts — keep in step.
    const clientFormatINRShort = (n) => {
      const v = n || 0;
      if (v >= 1e7) return `₹${(v / 1e7).toFixed(v % 1e7 ? 1 : 0).replace(/\.0$/, "")}Cr`;
      if (v >= 1e5) return `₹${(v / 1e5).toFixed(1).replace(/\.0$/, "")}L`;
      if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
      return `₹${v.toLocaleString("en-IN")}`;
    };
    const probes = [0, 1, 999, 1000, 1500, 99999, 100000, 250000, 700000, 720000, 750000, 999999, 1000000, 9999999, 1e7, 12500000, 25000000, 99999999];
    const mismatched = probes.filter((v) => shortINR(v) !== clientFormatINRShort(v));
    ok(mismatched.length === 0, `server and client money formatting agree on all ${probes.length} probes${mismatched.length ? ` (differ at ${mismatched.join(", ")})` : ""}`);
    ok(shortINR(250000) === "₹2.5L", "…₹2,50,000 renders as ₹2.5L on both");
    ok(shortINR(999999) === "₹10L", "…and the boundary that HAD drifted now agrees");
    ok(shortINR(100000).startsWith("₹"), "…every output carries the ₹ symbol");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    for (const v of created.venues) {
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueHold.deleteMany({ venue: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

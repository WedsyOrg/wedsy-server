// Auto-assign wiring on the INTAKE paths. Run:
//   node tests/venue-autoassign-intake.test.js
//
// utils/venueLeadAssign has existed and been tested since MB-CRM S0a but was
// never wired into the public createEnquiry path or the importer. The
// consequence (product map dead-end #5): an inbound lead lands unassigned, and
// an unassigned lead is INVISIBLE to every member without leads_view_all — so a
// scoped Sales team never sees the leads the website generates.
//
// This suite asserts the wiring AND the invisibility it fixes.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueTeamMember = require("../models/VenueTeamMember");

const enq = require("../controllers/venueEnquiry");

const TAG = `venue-aa-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const publicReq = (venue, body) => ({ params: { slug: venue.slug }, query: {}, body, auth: null });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── auto-assign OFF (default): behaviour is unchanged ──
    console.log("\n[auto-assign OFF — unchanged behaviour]");
    const vOff = await Venue.create({ name: `${TAG}-off`, slug: `${TAG}-off` });
    created.venues.push(vOff._id);
    const offMember = await VenueTeamMember.create({ venueId: vOff._id, ownerId: OWNER, name: `${TAG}-off-s`, phone: `${TAG}o1`, role: "sales", isActive: true });
    created.members.push(offMember._id);

    const rOff = await call(enq.createEnquiry, publicReq(vOff, { coupleName: "Off Couple", couplePhone: "9111000001" }));
    ok(rOff.code === 201, "inbound enquiry → 201");
    ok(rOff.body.enquiry.assignedTo == null, "with auto-assign off the lead stays unassigned (no behaviour change)");

    // ── auto-assign ON ──
    console.log("\n[auto-assign ON — inbound web enquiry]");
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, settings: { autoAssignLeads: true } });
    created.venues.push(venue._id);
    const mk = async (s) => { const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true }); created.members.push(m._id); return m; };
    const salesA = await mk("A");
    const salesB = await mk("B");

    const r1 = await call(enq.createEnquiry, publicReq(venue, { coupleName: "Sharma Wedding", couplePhone: "9111000010" }));
    ok(r1.code === 201, "inbound enquiry → 201");
    const lead1 = await VenueEnquiry.findById(r1.body.enquiry._id).lean();
    ok(lead1.assignedTo != null, "THE FIX: an inbound web enquiry is auto-assigned instead of vanishing");
    ok(String(lead1.assignedTo) === String(salesA._id), "…to the least-loaded Sales member (ties → earliest joined)");
    ok(lead1.activities.some((a) => a.type === "auto_assigned" && a.via === "round_robin"), "…and the assignment is audited on the timeline (via/actor answer 'why is it here?')");

    // Load balancing: the second lead goes to the other member.
    const r2 = await call(enq.createEnquiry, publicReq(venue, { coupleName: "Iyer Wedding", couplePhone: "9111000011" }));
    const lead2 = await VenueEnquiry.findById(r2.body.enquiry._id).lean();
    ok(String(lead2.assignedTo) === String(salesB._id), "the next inbound lead balances onto the other member");

    // ── the invisibility this fixes ──
    console.log("\n[the bug it fixes: scoped Sales can now see their inbound leads]");
    const listA = await call(enq.getVenueEnquiries, memberReq(venue, salesA));
    ok(listA.body.enquiries.length === 1 && String(listA.body.enquiries[0]._id) === String(lead1._id),
      "a scoped Sales member SEES the inbound lead routed to them (before: zero — the lead was invisible to the whole team)");
    const readA = await call(enq.getEnquiryById, memberReq(venue, salesA, { params: { enquiryId: String(lead1._id) } }));
    ok(readA.code === 200, "…and can open it");
    const crossRead = await call(enq.getEnquiryById, memberReq(venue, salesB, { params: { enquiryId: String(lead1._id) } }));
    ok(crossRead.code === 404, "…while the OTHER member still cannot (scoping is intact, not loosened)");

    // ── stage/assignedTo are still not client-settable on a public endpoint ──
    console.log("\n[public endpoint stays hostile-input safe]");
    const hostile = await call(enq.createEnquiry, publicReq(venue, { coupleName: "Hostile", couplePhone: "9111000012", stage: "booked", assignedTo: String(salesB._id) }));
    const hostileLead = await VenueEnquiry.findById(hostile.body.enquiry._id).lean();
    ok(hostileLead.stage === "new", "a client-supplied stage is still ignored");
    // Both members now hold one lead, so round-robin ties → earliest-joined
    // (salesA). The caller asked for salesB and did not get it: assignment is
    // decided server-side on the public endpoint, never by the request body.
    ok(String(hostileLead.assignedTo) === String(salesA._id),
      "a client-supplied assignedTo is ignored — round-robin decided (tie → earliest joined), not the caller");
    ok(hostileLead.activities.some((a) => a.type === "auto_assigned"), "…and it went through round-robin");

    // ── no active member → lead is kept, not lost ──
    console.log("\n[intake never dies]");
    const vEmpty = await Venue.create({ name: `${TAG}-e`, slug: `${TAG}-e`, settings: { autoAssignLeads: true } });
    created.venues.push(vEmpty._id);
    const rEmpty = await call(enq.createEnquiry, publicReq(vEmpty, { coupleName: "No Team", couplePhone: "9111000020" }));
    ok(rEmpty.code === 201, "a venue with no active members still accepts the enquiry");
    ok((await VenueEnquiry.findById(rEmpty.body.enquiry._id).lean()).assignedTo == null, "…and leaves it unassigned for the owner rather than losing it");

    const inactive = await VenueTeamMember.create({ venueId: vEmpty._id, ownerId: OWNER, name: `${TAG}-inact`, phone: `${TAG}i`, role: "sales", isActive: false });
    created.members.push(inactive._id);
    const rInact = await call(enq.createEnquiry, publicReq(vEmpty, { coupleName: "Inactive Only", couplePhone: "9111000021" }));
    ok((await VenueEnquiry.findById(rInact.body.enquiry._id).lean()).assignedTo == null, "a lead is never parked on an INACTIVE member");

    // ── importer ──
    console.log("\n[importer + sheets sync]");
    const imp = await enq.importLeadRows(venue._id, [
      { coupleName: "Import One", couplePhone: "9111000030" },
      { coupleName: "Import Two", couplePhone: "9111000031" },
      { coupleName: "Explicit", couplePhone: "9111000032", assignedTo: String(salesB._id) },
    ]);
    ok(imp.created === 3, "3 rows imported");
    const impOne = await VenueEnquiry.findOne({ couplePhone: "9111000030" }).lean();
    ok(impOne.assignedTo != null, "imported leads are auto-assigned too (same invisibility trap)");
    ok(impOne.activities.some((a) => a.type === "auto_assigned"), "…and audited");
    const explicit = await VenueEnquiry.findOne({ couplePhone: "9111000032" }).lean();
    ok(String(explicit.assignedTo) === String(salesB._id), "an explicit per-row assignee WINS over round-robin");
    ok(!explicit.activities.some((a) => a.type === "auto_assigned"), "…and is not mislabelled as auto-assigned");

    const impOff = await enq.importLeadRows(vOff._id, [{ coupleName: "Off Import", couplePhone: "9111000040" }]);
    ok(impOff.created === 1 && (await VenueEnquiry.findOne({ couplePhone: "9111000040" }).lean()).assignedTo == null,
      "with auto-assign off, imports stay unassigned (no behaviour change)");

    const impBad = await enq.importLeadRows(venue._id, [{ coupleName: "Bad Assignee", couplePhone: "9111000041", assignedTo: String(new mongoose.Types.ObjectId()) }]);
    ok(impBad.created === 1, "a row naming a non-member does not 422 the import");
    const badRow = await VenueEnquiry.findOne({ couplePhone: "9111000041" }).lean();
    ok(badRow.assignedTo != null && String(badRow.assignedTo) !== "000000000000000000000000",
      "…it falls back to round-robin rather than persisting a dangling member id");

    // ── EDGE 2 still holds: a dedup skip cannot reassign an owned lead ──
    console.log("\n[EDGE 2 preserved]");
    const ownerBefore = String(lead1.assignedTo);
    const dup = await enq.importLeadRows(venue._id, [{ coupleName: "Sharma Again", couplePhone: "9111000010", assignedTo: String(salesB._id) }]);
    ok(dup.skipped === 1 && dup.created === 0, "a duplicate row is skipped");
    ok(String((await VenueEnquiry.findById(lead1._id).lean()).assignedTo) === ownerBefore,
      "…and the existing lead keeps its owner (EDGE 2: a dedup match never reassigns)");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueFollowUp.deleteMany({ lead: { $in: leads.map((l) => l._id) } });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

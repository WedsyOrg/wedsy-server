// MB-CRM-2 S1 — contacts / functions / requirements + hold↔lead + chat↔lead
// links + any-contact-phone dedup. Run: node tests/venue-crm-s1.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueHold = require("../models/VenueHold");
const VenueConversation = require("../models/VenueConversation");

const enq = require("../controllers/venueEnquiry");
const calendar = require("../controllers/venueCalendar");
const { buildSeedContacts } = require("../scripts/migrate-enquiry-contacts");

const TAG = `mbcrm2-s1-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG}-v`,
      slug: `${TAG}-v`,
      spaces: [
        { name: "North lawn", type: "outdoor", isBookable: true },
        { name: "Banquet hall", type: "indoor", isBookable: true },
        { name: "Display foyer", type: "indoor", isBookable: false },
      ],
    });
    created.venues.push(venue._id);
    const lawn = venue.spaces[0]._id;
    const hall = venue.spaces[1]._id;
    const foyer = venue.spaces[2]._id;

    // ── pure migration seeding decision ──
    console.log("\n[migration: buildSeedContacts (pure)]");
    ok(buildSeedContacts({ coupleName: "A & K", couplePhone: "98111" })[0].isPrimary === true, "legacy couple fields seed one primary contact");
    ok(buildSeedContacts({ coupleName: "", couplePhone: "", name: "N", phone: "P" })[0].name === "N", "falls back to name/phone mirrors");
    ok(buildSeedContacts({ coupleName: "X", contacts: [{ name: "y" }] }) === null, "already-migrated rows are skipped");
    ok(buildSeedContacts({ coupleName: "", couplePhone: "" }) === null, "no identity → nothing to seed");

    // ── contacts ──
    console.log("\n[S1a contacts]");
    const mk = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} Ananya`, couplePhone: "+91 98860 01234", budget: "₹18–22L" } }));
    ok(mk.code === 201, "createManualLead 201");
    ok(mk.body.enquiry.budget === "₹18–22L", "budget stored on manual create");
    ok(mk.body.enquiry.contacts.length === 1 && mk.body.enquiry.contacts[0].isPrimary === true, "primary contact auto-seeded from name+phone");
    ok(mk.body.matchedLead === undefined, "no dedup match on first create");
    const leadId = String(mk.body.enquiryId);
    const p = { enquiryId: leadId };

    const cUpd = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { contacts: [
      { name: "Ananya Rao", phone: "+91 98860 01234", role: "bride" },
      { name: "Kabir Mehra", phone: "9886002211", role: "groom", isPrimary: true },
      { name: "Suresh Rao", phone: "9886008899", role: "brides_father" },
    ] } }));
    ok(cUpd.code === 200, "contacts wholesale update 200");
    ok(cUpd.body.enquiry.contacts.length === 3, "three contacts stored");
    ok(cUpd.body.enquiry.contacts.filter((c) => c.isPrimary).length === 1 && cUpd.body.enquiry.contacts[1].isPrimary, "exactly one primary — the explicitly marked one");
    // BUILD A CHANGED THIS DELIBERATELY. The PHONE still follows the primary
    // contact — that is what dedup, WhatsApp and the legacy dashboards read.
    // The NAME no longer does. Under the old rule, marking the groom primary
    // silently renamed the whole lead to just the groom and erased the bride,
    // which is exactly the "coupleName is one string so bride and groom don't
    // exist separately" problem BUILD A exists to fix. A name a human typed is
    // now an override that sticks; clearing it hands the row to the derivation,
    // which composes "Ananya Rao & Kabir Mehra" from the two relations.
    ok(cUpd.body.enquiry.couplePhone === "9886002211", "the legacy couplePhone mirror still follows the primary contact");
    ok(cUpd.body.enquiry.coupleName === `${TAG} Ananya`, "…and the typed name is NOT overwritten by the primary contact any more");
    const derivedNow = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { coupleName: "" } }));
    ok(derivedNow.body.enquiry.coupleName === "Ananya Rao & Kabir Mehra", "…clearing the name derives it from the bride and groom instead");
    const badRole = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { contacts: [{ name: "Z", phone: "1", role: "uncle" }] } }));
    ok(badRole.code === 200 && badRole.body.enquiry.contacts[0].role === "other", "unknown role coerces to other");
    const noneP = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { contacts: [{ name: "OnlyName" }, { name: "Second", phone: "22" }] } }));
    ok(noneP.code === 200 && noneP.body.enquiry.contacts[0].isPrimary === true, "no primary marked → first becomes primary");
    const emptyRow = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { contacts: [{ role: "bride" }] } }));
    ok(emptyRow.code === 400, "contact with neither name nor phone → 400");

    // restore the real contacts for dedup tests below
    await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { contacts: [
      { name: "Ananya Rao", phone: "+91 98860 01234", role: "bride", isPrimary: true },
      { name: "Suresh Rao", phone: "9886008899", role: "brides_father" },
    ] } }));

    // ── functions ──
    console.log("\n[S1b functions]");
    const win = { checkIn: "2026-12-13T14:00:00Z", checkOut: "2026-12-15T11:00:00Z" };
    const fOk = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { ...win, functions: [
      { name: "mehendi", date: "2026-12-13", timeSlot: "4–8 PM", space: String(lawn), expectedPax: 80 },
      { name: "sangeet", date: "2026-12-13", timeSlot: "8 PM–1 AM", space: String(hall), expectedPax: 220 },
      { name: "wedding", date: "2026-12-14", timeSlot: "6 PM–12 AM", space: String(lawn), expectedPax: 320 },
    ] } }));
    ok(fOk.code === 200 && fOk.body.enquiry.functions.length === 3, "functions within the window store (two share 13 Dec in different spaces — no conflict)");
    const fOut = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { functions: [{ name: "reception", date: "2026-12-20", space: String(hall) }] } }));
    ok(fOut.code === 400 && /window/.test(fOut.body.message), "function date outside [checkIn, checkOut] → 400");
    const fSpace = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { functions: [{ name: "wedding", date: "2026-12-14", space: String(new mongoose.Types.ObjectId()) }] } }));
    ok(fSpace.code === 400 && /space/.test(fSpace.body.message), "unknown space → 400");
    const fFoyer = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { functions: [{ name: "wedding", date: "2026-12-14", space: String(foyer) }] } }));
    ok(fFoyer.code === 400 && /not bookable/.test(fFoyer.body.message), "non-bookable space → 400");
    const fCustom = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { functions: [{ name: "custom", date: "2026-12-14" }] } }));
    ok(fCustom.code === 400 && /customLabel/.test(fCustom.body.message), "custom function without customLabel → 400");
    const fCustom2 = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { functions: [{ name: "custom", customLabel: "Pool party", date: "2026-12-14", space: String(lawn) }] } }));
    ok(fCustom2.code === 200 && fCustom2.body.enquiry.functions[0].customLabel === "Pool party", "custom function with label stores");
    const winShrink = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { checkIn: "2026-12-15T14:00:00Z", checkOut: "2026-12-16T11:00:00Z" } }));
    ok(winShrink.code === 400 && /orphan/.test(winShrink.body.message), "moving the window off an existing function date → 400");
    // put the good functions back
    await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { ...win, functions: [
      { name: "wedding", date: "2026-12-14", timeSlot: "6 PM–12 AM", space: String(lawn), expectedPax: 320 },
    ] } }));

    // ── requirements ──
    console.log("\n[S1c requirements]");
    const rOk = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { requirements: { food: "both", catering: "inhouse", alcohol: true, roomsNeeded: 40, decorNotes: "Premium florals, pastel" } } }));
    ok(rOk.code === 200 && rOk.body.enquiry.requirements.food === "both" && rOk.body.enquiry.requirements.roomsNeeded === 40, "requirements store");
    const rPartial = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { requirements: { catering: "both" } } }));
    ok(rPartial.code === 200 && rPartial.body.enquiry.requirements.food === "both" && rPartial.body.enquiry.requirements.catering === "both", "partial requirements merge (unsent keys survive)");
    const rBad = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { requirements: { food: "jain" } } }));
    ok(rBad.code === 400, "unknown requirements.food → 400");
    const rBadRooms = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { requirements: { roomsNeeded: -3 } } }));
    ok(rBadRooms.code === 400, "negative roomsNeeded → 400");

    // ── dedup: any contact phone ──
    console.log("\n[S1a dedup on ANY contact phone]");
    // Suresh's number (a NON-primary contact of lead 1) comes in as a new lead's couplePhone.
    const mk2 = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} Suresh walkin`, couplePhone: "98860 08899", source: "walk_in" } }));
    ok(mk2.code === 201, "dedup-matching create still creates its own lead (never blocks)");
    ok(mk2.body.matchedLead && String(mk2.body.matchedLead._id) === leadId, "matchedLead surfaces the existing lead via the contact phone");
    const lead1After = await VenueEnquiry.findById(leadId).lean();
    ok(String(mk2.body.enquiryId) !== leadId && lead1After.deleted !== true, "EDGE 2: the existing lead is untouched (no silent merge/reassign)");
    const ex = await call(enq.checkEnquiryExists, ownerReq(venue, { query: { phone: "+91-98860-08899" } }));
    ok(ex.body.exists === true && ex.body.matchedLead, "exists-check matches on a contact phone (+ matchedLead payload)");
    // bidirectional: lead 1 sees lead 2 in its read too
    const read1 = await call(enq.getEnquiryById, ownerReq(venue, { params: p }));
    ok(read1.body.enquiry.matchedLead && String(read1.body.enquiry.matchedLead._id) === String(mk2.body.enquiryId), "dedup banner is bidirectional (lead 1 links lead 2)");

    // scoped: a Sales member who can't see lead 1 gets NO matchedLead
    const mkM = async (s) => { const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true }); created.members.push(m._id); return m; };
    const salesB = await mkM("B");
    const mk3 = await call(enq.createManualLead, memberReq(venue, salesB, { body: { coupleName: `${TAG} Scoped dup`, couplePhone: "9886001234" } }));
    ok(mk3.code === 201 && mk3.body.matchedLead === undefined, "scoped member's dedup match outside their scope is NOT revealed (invariant #11)");

    // import dedup keys on contact phones too (EDGE 2 skip, assignedTo preserved)
    const impRes = await call(enq.importLeads, ownerReq(venue, { body: { rows: [{ coupleName: "Dup Row", couplePhone: "9886008899", assignedTo: String(salesB._id) }], fileName: "t.csv" } }));
    ok(impRes.code === 200 && impRes.body.skipped === 1 && impRes.body.created === 0, "import skips a row whose phone matches an existing CONTACT phone");
    ok(String((await VenueEnquiry.findById(leadId).lean()).assignedTo || "") === "", "EDGE 2 holds: the skipped row's assignedTo never touches the existing lead");

    // ── hold↔lead ──
    console.log("\n[S1d hold↔lead]");
    const notesBefore = (await VenueEnquiry.findById(leadId).lean()).notes.length;
    const mkHold = await call(calendar.createHold, ownerReq(venue, { body: { dates: ["2026-12-14"], linkedEnquiry: leadId, requestedByName: "Ananya Rao" } }));
    ok(mkHold.code === 201 && String(mkHold.body.hold.linkedEnquiry) === leadId, "createHold links the enquiry");
    const afterHold = await VenueEnquiry.findById(leadId).lean();
    // WALKTHROUGH FIX 2 CHANGED THIS CONTRACT, deliberately. The hold used to
    // be written into notes[] AND activities[], and the lead page's timeline
    // merges both — so every hold rendered TWICE at one timestamp. It is an
    // activity, not a hand-typed note, and notes[] must stay what a human
    // wrote. The assertion now pins the fixed behaviour in both directions.
    const holdActs = afterHold.activities.filter((a) => a.type === "hold_requested");
    ok(holdActs.length === 1 && /Hold requested/.test(holdActs[0].description), "hold request lands on the lead's timeline as ONE activity");
    ok(afterHold.notes.length === notesBefore, "…and writes nothing to notes[], so the merged timeline shows it once");
    const holdId = String(mkHold.body.hold._id);
    const app = await call(calendar.approveHold, ownerReq(venue, { params: { holdId } }));
    ok(app.code === 200, "hold approved");
    const read2 = await call(enq.getEnquiryById, ownerReq(venue, { params: p }));
    ok(read2.body.enquiry.hold && read2.body.enquiry.hold.status === "approved" && read2.body.enquiry.hold.holdExpiry, "lead read exposes the live hold + holdExpiry");
    const list = await call(enq.getVenueEnquiries, ownerReq(venue));
    const row = list.body.enquiries.find((e) => String(e._id) === leadId);
    ok(row && row.hold && row.hold.status === "approved", "list read carries the live hold too");
    const rel = await call(calendar.releaseHold, ownerReq(venue, { params: { holdId } }));
    ok(rel.code === 200, "hold released");
    const afterRel = await VenueEnquiry.findById(leadId).lean();
    // Same contract change as the request above — an activity, not a note.
    const relActs = afterRel.activities.filter((a) => a.type === "hold_released");
    ok(relActs.length === 1 && /Hold released/.test(relActs[0].description), "release lands on the lead's timeline as ONE activity (symmetric)");
    ok(afterRel.notes.length === notesBefore, "…and still nothing in notes[]");
    const read3 = await call(enq.getEnquiryById, ownerReq(venue, { params: p }));
    ok(read3.body.enquiry.hold === null, "released hold no longer surfaces on the lead read");

    // functions spaceName resolution rides the single read
    ok((read3.body.enquiry.functions || []).every((f) => !f.space || f.spaceName), "single read resolves function space ids to names");

    // ── chat↔lead ──
    console.log("\n[S1e chat↔lead]");
    ok(read3.body.enquiry.threadId === null, "no conversation → threadId null");
    const convo = await VenueConversation.create({ venueId: venue._id, enquiryId: leadId, userId: new mongoose.Types.ObjectId() });
    const read4 = await call(enq.getEnquiryById, ownerReq(venue, { params: p }));
    ok(String(read4.body.enquiry.threadId) === String(convo._id), "lead read returns the Wedsy thread id when one exists");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueHold.deleteMany({ venue: { $in: vids } });
      await VenueConversation.deleteMany({ venueId: { $in: vids } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

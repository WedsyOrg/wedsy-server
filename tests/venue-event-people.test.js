// BUILD A — event type + the people model.
// Run: node tests/venue-event-people.test.js
//
// The three things that carry real regression risk, each asserted rather than
// argued:
//   · coupleName is read in ~60 files (lists, search, DEDUP, PDFs, WhatsApp,
//     the couple site). It must stay a stored String that every existing
//     consumer still sees, the derivation must never BLANK a name, and a manual
//     name must always win.
//   · dedup keys on ANY contact phone, and EDGE 2 (a matching create keeps its
//     own record and owner) must still hold now that contacts have new fields.
//   · the product must not fork: only the wedding-specific layer changes with
//     eventType, and a type change must never destroy stored data.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const AuspiciousDate = require("../models/AuspiciousDate");
const BlackoutPeriod = require("../models/BlackoutPeriod");

const enq = require("../controllers/venueEnquiry");
const et = require("../utils/venueEventType");
const cn = require("../utils/venueCoupleName");
const { composeCalendarNote } = require("../utils/venueCalendarNote");
const { resolveBlock } = require("../utils/weddingCalendar");
const { leadDays } = require("../utils/venueContention");

const TAG = `evp-${Date.now()}`;
const YEAR = 2094;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() }, venueMember: null });
const memberReq = (venue, m, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: m._id, role: m.role }, venueMember: m });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [], members: [], roles: [] };
const d = (mmdd) => `${YEAR}-${mmdd}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await Promise.all([AuspiciousDate.deleteMany({ year: YEAR }), BlackoutPeriod.deleteMany({ year: YEAR })]);

    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);

    // ── vocabulary ──────────────────────────────────────────────────────────
    console.log("\n[vocabulary: the whole list of what differs by type]");
    ok(et.cleanEventType(undefined) === "social", "an absent type reads as social — every existing row is a wedding");
    ok(et.cleanEventType("nonsense") === "social", "…and so does junk");
    ok(et.functionVocabulary("social").includes("mehendi"), "social keeps the wedding functions");
    ok(!et.functionVocabulary("corporate").includes("mehendi"), "corporate does not offer mehendi");
    ok(et.functionVocabulary("corporate").includes("conference"), "…it offers conference");
    ok(et.functionVocabulary("corporate").includes("custom"), "…and both keep the custom escape hatch");
    ok(et.relationVocabulary("social").includes("brides_father"), "social relations include the bride's father");
    ok(et.relationVocabulary("corporate").includes("finance"), "corporate relations include finance");
    ok(!et.relationVocabulary("corporate").includes("bride"), "…and no bride");
    ok(et.showsAuspicious("social") && !et.showsAuspicious("corporate"), "muhurat advice is social-only");
    ok(et.blackoutSense("social") === "negative" && et.blackoutSense("corporate") === "positive", "THE INVERSION: a blackout is negative for social, positive for corporate");
    ok(et.nameLabel("corporate") !== et.nameLabel("social"), "the name label differs by type");

    // ── coupleName derivation ───────────────────────────────────────────────
    console.log("\n[coupleName: derived, overridable, never blanked]");
    const C = (name, relation, extra = {}) => ({ name, relation, phone: "", isPrimary: false, ...extra });
    ok(cn.deriveCoupleName([C("Priya", "bride"), C("Arjun", "groom")]) === "Priya & Arjun", "bride + groom → 'Priya & Arjun'");
    ok(cn.deriveCoupleName([C("Arjun", "groom"), C("Priya", "bride")]) === "Priya & Arjun", "…bride first regardless of array order");
    ok(cn.deriveCoupleName([C("Priya", "bride")]) === "Priya", "bride alone → the bride");
    ok(cn.deriveCoupleName([C("Arjun", "groom")]) === "Arjun", "groom alone → the groom");
    ok(cn.deriveCoupleName([C("Ravi", "planner", { isPrimary: true }), C("X", "other")]) === "Ravi", "no couple → the primary contact");
    ok(cn.deriveCoupleName([]) === "", "nothing to go on → empty, so callers can tell");

    // Rule 5 is the dangerous one: derivation must never remove a name.
    const blankable = { coupleName: "Existing Name", name: "Existing Name", contacts: [] };
    cn.applyCoupleName(blankable);
    ok(blankable.coupleName === "Existing Name", "THE BLANK GUARD: a lead with no usable contacts keeps its name");
    const phoneOnly = { coupleName: "Kept", contacts: [{ name: "", phone: "9800000001", relation: "other", isPrimary: true }] };
    cn.applyCoupleName(phoneOnly);
    ok(phoneOnly.coupleName === "Kept", "…and a phone-only contact does not blank it either");

    const manual = { coupleName: "The Mehra Wedding", coupleNameManual: true, contacts: [C("Priya", "bride"), C("Arjun", "groom")] };
    cn.applyCoupleName(manual);
    ok(manual.coupleName === "The Mehra Wedding", "a manual name beats bride + groom");
    cn.setManualCoupleName(manual, "");
    ok(manual.coupleName === "Priya & Arjun" && manual.coupleNameManual === false, "clearing the override hands the row back to the derivation");

    // ── create: type, seeded contact, name lock ─────────────────────────────
    console.log("\n[create]");
    const socialRes = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: "Aarav & Diya", couplePhone: "9800001001", email: "aarav@example.com" } }));
    ok(socialRes.code === 201, "manual create → 201");
    ok(socialRes.body.enquiry.eventType === "social", "…defaults to social");
    const seeded = socialRes.body.enquiry.contacts[0];
    ok(seeded && seeded.isPrimary === true, "…seeds a primary contact from the form");
    ok(seeded.email === "aarav@example.com", "…carrying the optional email");
    ok(seeded.relation === "other", "…with a neutral relation for social");
    ok(socialRes.body.enquiry.coupleNameManual === true, "…and the typed name is marked manual so contacts never rewrite it");

    const corpRes = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: "Infosys Offsite", couplePhone: "9800001002", eventType: "corporate" } }));
    ok(corpRes.code === 201 && corpRes.body.enquiry.eventType === "corporate", "corporate create → 201, type stored");
    ok(corpRes.body.enquiry.contacts[0].relation === "main_contact", "…seeds a main_contact, not 'other'");
    ok((await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: "X", couplePhone: "9800001003", eventType: "birthday" } }))).code === 400, "an unknown eventType → 400");

    const socialId = String(socialRes.body.enquiry._id);
    const corpId = String(corpRes.body.enquiry._id);

    // ── contacts: relation, email, decision maker ───────────────────────────
    console.log("\n[contacts are the whole people model]");
    const withPeople = await call(enq.updateEnquiry, ownerReq(venue, {
      params: { enquiryId: socialId },
      body: { contacts: [
        { name: "Priya", phone: "9800002001", relation: "bride" },
        { name: "Arjun", phone: "9800002002", relation: "groom", isPrimary: true },
        { name: "Mr Sharma", phone: "9800002003", relation: "brides_father", email: "sharma@example.com", isDecisionMaker: true },
      ] },
    }));
    ok(withPeople.code === 200, "contacts save → 200");
    const saved = withPeople.body.enquiry.contacts;
    ok(saved.length === 3, "…all three stored");
    ok(saved.find((c) => c.relation === "bride").name === "Priya", "…bride is just a contact with a relation");
    ok(saved.find((c) => c.isPrimary).relation === "groom", "THE GROOM IS THE ONE CALLING — primary is independent of relation");
    ok(saved.find((c) => c.isDecisionMaker).relation === "brides_father", "…and the decision maker is the bride's father");
    ok(saved.find((c) => c.relation === "brides_father").email === "sharma@example.com", "…email stored");
    ok(saved.filter((c) => c.isPrimary).length === 1, "exactly one primary is still enforced");
    ok(saved.filter((c) => c.isDecisionMaker).length === 1, "decision maker is NOT forced to exist or be unique — it just is what it is");
    ok(saved[0].role === saved[0].relation, "the legacy `role` mirror is kept in step for un-migrated readers");

    // The name did NOT change, because it was typed.
    const afterPeople = await VenueEnquiry.findById(socialId).lean();
    ok(afterPeople.coupleName === "Aarav & Diya", "a manual name survives adding bride + groom");
    // Clear it → derivation takes over.
    await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: socialId }, body: { coupleName: "" } }));
    const derived = await VenueEnquiry.findById(socialId).lean();
    ok(derived.coupleName === "Priya & Arjun", "clearing it derives 'Priya & Arjun' from the contacts");
    ok(derived.name === derived.coupleName, "…and `name` follows coupleName exactly as it always did");
    ok(derived.couplePhone === "9800002002", "…couplePhone still follows the PRIMARY contact");

    ok((await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: socialId }, body: { contacts: [{ name: "X", phone: "9", email: "not-an-email" }] } }))).code === 400, "a malformed contact email → 400");

    // A relation from the wrong vocabulary coerces rather than 400s — a lead
    // that just switched type must not become unsaveable.
    const coerced = await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: corpId }, body: { contacts: [{ name: "Anita", phone: "9800002010", relation: "bride" }] } }));
    ok(coerced.code === 200 && coerced.body.enquiry.contacts[0].relation === "other", "a social relation on a corporate lead coerces to 'other', never 400");

    // ── type change ─────────────────────────────────────────────────────────
    console.log("\n[type change never destroys data]");
    const fnLead = await call(enq.createManualLead, ownerReq(venue, {
      body: { coupleName: "Switcher", couplePhone: "9800003001", checkIn: d("11-20"), checkOut: d("11-22") },
    }));
    const fnId = String(fnLead.body.enquiry._id);
    const withFn = await call(enq.updateEnquiry, ownerReq(venue, {
      params: { enquiryId: fnId }, body: { functions: [{ name: "mehendi", date: d("11-20") }] },
    }));
    ok(withFn.code === 200, "a social lead stores a mehendi");
    ok((await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: fnId }, body: { functions: [{ name: "conference", date: d("11-20") }] } }))).code === 400, "…and cannot store a conference while social");

    const switched = await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: fnId }, body: { eventType: "corporate" } }));
    ok(switched.code === 200 && switched.body.enquiry.eventType === "corporate", "the type switches");
    const afterSwitch = await VenueEnquiry.findById(fnId).lean();
    ok(afterSwitch.functions.length === 1 && afterSwitch.functions[0].name === "mehendi", "THE DATA SURVIVES: the mehendi row is still there, not silently deleted");
    ok(afterSwitch.activities.some((a) => a.type === "event_type_changed"), "…and the change is on the timeline");
    ok((await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: fnId }, body: { functions: [{ name: "conference", date: d("11-20") }] } }))).code === 200, "now a conference saves");
    ok((await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: fnId }, body: { functions: [{ name: "mehendi", date: d("11-20") }] } }))).code === 400, "…and a mehendi no longer does");
    // Switch type AND send the new vocabulary in ONE request.
    const oneShot = await call(enq.updateEnquiry, ownerReq(venue, {
      params: { enquiryId: fnId },
      body: { eventType: "social", functions: [{ name: "sangeet", date: d("11-21") }] },
    }));
    ok(oneShot.code === 200, "type + new-vocabulary functions in ONE request works");

    // ── the note: suppression and inversion ─────────────────────────────────
    console.log("\n[the note reads the calendar by type]");
    await AuspiciousDate.create({ date: new Date(`${d("11-21")}T00:00:00Z`), year: YEAR, month: 11, day: 21, traditions: ["north_indian"], tier: "major", verified: true });
    await BlackoutPeriod.create({ name: `${TAG}-Chaturmas`, startDate: new Date(`${d("07-14")}T00:00:00Z`), endDate: new Date(`${d("10-31")}T00:00:00Z`), traditions: [], year: YEAR, verified: true });

    const noteFor = async (dayKey, eventType) => {
      const block = await resolveBlock({ venue, dayKeys: leadDays({ checkIn: new Date(`${dayKey}T06:00:00Z`) }) });
      return composeCalendarNote({ block, contention: { count: 0, sole: true, blocks: { buckets: [], total: 0 }, ownBlock: "24h", date: dayKey }, checkIn: `${dayKey}T06:00:00Z`, eventType });
    };

    const ausSocial = await noteFor(d("11-21"), "social");
    ok(/muhurat/i.test(ausSocial.text), "a muhurat date reads as one for social");
    const ausCorp = await noteFor(d("11-21"), "corporate");
    ok(!/muhurat|auspicious/i.test(ausCorp.text), "…and is SUPPRESSED for corporate");
    ok(ausCorp.signals.auspicious === null, "…the signal itself is null, not just the prose");

    const boSocial = await noteFor(d("08-12"), "social");
    ok(/Almost no Hindu weddings/.test(boSocial.text), "a blackout warns for social");
    ok(/Few enquiries will come/.test(boSocial.text), "…and says demand will be thin");
    const boCorp = await noteFor(d("08-12"), "corporate");
    ok(/quiet season for weddings/.test(boCorp.text), "THE INVERSION: the same blackout reads as opportunity for corporate");
    ok(/exactly what fills these dates/.test(boCorp.text), "…and names the opportunity");
    ok(/wide open/.test(boCorp.text), "…and the demand line flips too");
    ok(/competitive on rate/.test(boCorp.text), "…and the action is about rate, not repurposing");
    ok(!/Few enquiries will come/.test(boCorp.text), "…with none of the warning copy left behind");
    ok(boCorp.signals.blackoutSense === "positive", "signals carry the sense so the UI can style it");
    ok(!/the couple has the leverage/.test(boCorp.text) && !/the couple/.test(ausCorp.text), "corporate copy never says 'the couple'");

    // ── coupleName consumers ────────────────────────────────────────────────
    console.log("\n[coupleName consumers are untouched by construction]");
    const stored = await VenueEnquiry.findById(socialId).lean();
    ok(typeof stored.coupleName === "string", "coupleName is still a STORED String, not a virtual");
    // The Mongo-level uses are what prove it cannot become a virtual.
    const byRegex = await VenueEnquiry.findOne({ venueId: venue._id, coupleName: /Priya/ }).lean();
    ok(Boolean(byRegex), "…searchable by regex IN THE DATABASE");
    const projected = await VenueEnquiry.find({ venueId: venue._id }).select("coupleName").limit(1).lean();
    ok(typeof projected[0].coupleName === "string", "…projectable via .select()");
    const sorted = await VenueEnquiry.find({ venueId: venue._id }).sort({ coupleName: 1 }).select("coupleName").lean();
    ok(sorted.length > 1 && sorted[0].coupleName <= sorted[sorted.length - 1].coupleName, "…sortable in the database");
    const grouped = await VenueEnquiry.aggregate([{ $match: { venueId: venue._id } }, { $group: { _id: "$coupleName" } }]);
    ok(grouped.length > 0, "…usable in an aggregation");
    const listed = await call(enq.getVenueEnquiries, ownerReq(venue, { query: {} }));
    ok(listed.code === 200 && listed.body.enquiries.some((e) => e.coupleName), "the leads list still shows names");

    // ── dedup + EDGE 2 ──────────────────────────────────────────────────────
    console.log("\n[dedup + EDGE 2 with the new contact shape]");
    const scopedRole = await VenueRole.create({ venue: venue._id, name: `${TAG}-sales`, capabilities: ["leads"] });
    created.roles.push(scopedRole._id);
    const memberA = await VenueTeamMember.create({ venueId: venue._id, name: `${TAG}-A`, phone: `${TAG}a`, role: "sales", roleRef: scopedRole._id, isActive: true });
    created.members.push(memberA._id);

    // Dedup keys on a CONTACT phone, not just the couplePhone mirror.
    const dupeByContact = await call(enq.createManualLead, ownerReq(venue, {
      body: { coupleName: "Same Family", couplePhone: "9800009999", contacts: [{ name: "Mr Sharma", phone: "9800002003", relation: "other", isPrimary: true }] },
    }));
    ok(dupeByContact.code === 201, "a create sharing only a CONTACT phone still succeeds");
    ok(Boolean(dupeByContact.body.matchedLead), "…and is flagged as a dedup match");

    // EDGE 2: the match must not steal the owner or block the create.
    const owned = await call(enq.createManualLead, memberReq(venue, memberA, {
      body: { coupleName: "Edge Two", couplePhone: "9800002003", assignedTo: String(memberA._id) },
    }));
    ok(owned.code === 201, "EDGE 2: a matching create is NOT blocked");
    ok(String(owned.body.enquiry.assignedTo) === String(memberA._id), "…and keeps its OWN owner");
    // The banner is SCOPED (invariant #11): this member owns nothing else, so
    // the lead they collide with is not theirs to be told about. Absence here
    // is the privacy rule working, not a missing feature — and the owner below
    // proves the banner itself still fires.
    ok(!owned.body.matchedLead, "…and a scoped member is NOT shown a match they cannot open");
    const ownerSeesIt = await call(enq.createManualLead, ownerReq(venue, {
      body: { coupleName: "Edge Two Owner", couplePhone: "9800002003" },
    }));
    ok(ownerSeesIt.code === 201 && Boolean(ownerSeesIt.body.matchedLead), "…while an owner creating the same duplicate DOES get the banner");
    const other = await VenueEnquiry.findById(socialId).lean();
    ok(String(other.coupleName) === "Priya & Arjun", "…and the matched lead is not modified at all");

    // ── deny sweep ──────────────────────────────────────────────────────────
    console.log("\n[deny sweep: scoped member vs another member's lead]");
    const before = await VenueEnquiry.findById(socialId).lean();
    const denyRead = await call(enq.getEnquiryById, memberReq(venue, memberA, { params: { enquiryId: socialId } }));
    ok(denyRead.code === 404, "read by direct id → 404, never 403");
    ok(!denyRead.body.enquiry, "…no body leaks");
    const denyWrite = await call(enq.updateEnquiry, memberReq(venue, memberA, {
      params: { enquiryId: socialId },
      body: { eventType: "corporate", coupleName: "HACKED", contacts: [{ name: "Mallory", phone: "666", relation: "other" }] },
    }));
    ok(denyWrite.code === 404, "write by direct id → 404");
    const after = await VenueEnquiry.findById(socialId).lean();
    ok(after.coupleName === before.coupleName, "THE WRITE DID NOT HAPPEN: name unchanged");
    ok(after.eventType === before.eventType, "…eventType unchanged");
    ok(after.contacts.length === before.contacts.length, "…contacts unchanged");
    ok(!after.contacts.some((c) => c.name === "Mallory"), "…and no contact was injected");

    // Soft-deleted leads stay excluded everywhere.
    await VenueEnquiry.updateOne({ _id: corpId }, { $set: { deleted: true, deletedAt: new Date() } });
    const afterDel = await call(enq.getVenueEnquiries, ownerReq(venue, { query: {} }));
    ok(!afterDel.body.enquiries.some((e) => String(e._id) === corpId), "a soft-deleted lead is excluded from the list");
    ok((await call(enq.getEnquiryById, ownerReq(venue, { params: { enquiryId: corpId } }))).code === 404, "…and unreachable by direct id");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    for (const v of created.venues) {
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await Promise.all([
      AuspiciousDate.deleteMany({ year: YEAR }),
      BlackoutPeriod.deleteMany({ $or: [{ year: YEAR }, { name: new RegExp(`^${TAG}`) }] }),
    ]).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

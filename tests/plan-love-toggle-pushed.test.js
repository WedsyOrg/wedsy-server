// LOVE/PASS toggle (idempotent per actor) + pushed-state read.
// Run: node tests/plan-love-toggle-pushed.test.js
// Covers: love twice by one actor = net zero (toggle off); love→pass = one pass;
// two actors keep their own; the note is untouched by love/pass; heart echo fires
// only on a net-new love; a look pushed to a draft reads pushed:true (+ draftIds),
// one not in any draft reads pushed:false.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Decor = require("../models/Decor");
const LeadPlan = require("../models/LeadPlan");
const Event = require("../models/Event");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const PlanService = require("../services/PlanService");
const DraftEventService = require("../services/DraftEventService");

const TAG = `plantoggle-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// love/pass reactions on a look matching a predicate.
const lp = (look, pred) => (look.reactions || []).filter((r) => (r.kind === "love" || r.kind === "pass") && pred(r));
const byAdmin = (id) => (r) => String(r.adminId || "") === String(id);
const byUser = (id) => (r) => String(r.userId || "") === String(id);

const created = { leads: [], admins: [], decors: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const admin2 = await Admin.create({ name: `${TAG}-admin2`, email: `${TAG}2@x.com`, phone: `${TAG}b`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin2._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDate: "2026-12-10", city: "Bangalore", eventDays: [{ date: "2026-12-09", functions: [{ type: "Sangeet", time: "19:00", venue: "TBD" }] }] },
    });
    created.leads.push(lead._id);
    const mkDecor = async (n) => {
      const d = await Decor.create({ category: "Stage", name: `${TAG}-${n}`, unit: "unit", image: `${n}.jpg`, thumbnail: `${n}-t.jpg`, productVisibility: true, productTypes: [{ name: "Standard", costPrice: 1000, sellingPrice: 2000 }] });
      created.decors.push(d._id);
      return d;
    };
    const decorA = await mkDecor("a");
    const decorB = await mkDecor("b");

    const lookA = await PlanService.addLook(lead._id, { source: "decor", decorId: decorA._id, functionKey: "sangeet", categoryKey: "stage" }, admin._id);
    const lookB = await PlanService.addLook(lead._id, { source: "decor", decorId: decorB._id, functionKey: "sangeet", categoryKey: "stage" }, admin._id);
    const userId = new mongoose.Types.ObjectId(); // stand-in couple actor

    // ── 1. LOVE TWICE by one actor = net zero (toggle off) ──
    let r = await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin._id });
    ok(lp(r, byAdmin(admin._id)).length === 1 && lp(r, byAdmin(admin._id))[0].kind === "love", "love once → one love for the actor");
    r = await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin._id });
    ok(lp(r, byAdmin(admin._id)).length === 0, "love again (same actor) → toggled OFF (net zero)");

    // ── 2. LOVE then PASS by one actor = one pass (replace) ──
    r = await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin._id });
    r = await PlanService.reactToLook(lead._id, lookA._id, { kind: "pass" }, { adminId: admin._id });
    const actorLP = lp(r, byAdmin(admin._id));
    ok(actorLP.length === 1 && actorLP[0].kind === "pass", "love → pass (same actor) → exactly one, and it's pass");

    // ── 3. TWO DIFFERENT ACTORS keep their own ──
    r = await PlanService.reactToLook(lead._id, lookB._id, { kind: "love", voice: "couple", name: "Priya", userId }, {});
    r = await PlanService.reactToLook(lead._id, lookB._id, { kind: "love" }, { adminId: admin2._id });
    ok(lp(r, byUser(userId)).length === 1 && lp(r, byAdmin(admin2._id)).length === 1, "two actors → each holds their own love");
    // toggling one actor off leaves the other intact
    r = await PlanService.reactToLook(lead._id, lookB._id, { kind: "love", voice: "couple", name: "Priya", userId }, {});
    ok(lp(r, byUser(userId)).length === 0 && lp(r, byAdmin(admin2._id)).length === 1, "toggling one actor off does NOT affect the other");

    // ── 4. NOTE is unaffected by love/pass toggling ──
    await PlanService.reactToLook(lead._id, lookA._id, { kind: "note", note: "gold pillars", source: "live_marked" }, { adminId: admin._id });
    await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin._id });
    r = await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin._id }); // toggle love off
    const notes = (r.reactions || []).filter((x) => x.kind === "note" && String(x.adminId || "") === String(admin._id));
    ok(notes.length === 1 && notes[0].note === "gold pillars", "the note survives love/pass toggling (one-per-actor, untouched)");
    ok(lp(r, byAdmin(admin._id)).length === 0, "…and the love is toggled off independently of the note");

    // ── heart echo fires ONLY on a net-new love ──
    const hearts0 = await LeadActivityEvent.countDocuments({ leadId: lead._id, kind: "heart", text: new RegExp(`${TAG}-a`) });
    await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin2._id }); // net-new love by admin2
    await PlanService.reactToLook(lead._id, lookA._id, { kind: "love" }, { adminId: admin2._id }); // toggle OFF — no echo
    const hearts1 = await LeadActivityEvent.countDocuments({ leadId: lead._id, kind: "heart", text: new RegExp(`${TAG}-a`) });
    ok(hearts1 - hearts0 === 1, "heart echo fires once on the net-new love, not on the toggle-off");

    // ── 5. PUSHED-STATE READ ──
    const draft = await DraftEventService.createDraft(lead._id, { name: "Dream" }, admin._id);
    await DraftEventService.pushToBuild(lead._id, { lookIds: [String(lookA._id)], draftIds: [String(draft._id)] }, admin._id);
    const planRead = await PlanService.getPlan(lead._id);
    const rA = planRead.looks.find((l) => String(l._id) === String(lookA._id));
    const rB = planRead.looks.find((l) => String(l._id) === String(lookB._id));
    ok(rA.pushed === true && rA.pushedDraftIds.map(String).includes(String(draft._id)), "look pushed to a draft reads pushed:true + the draftId");
    ok(rB.pushed === false && Array.isArray(rB.pushedDraftIds) && rB.pushedDraftIds.length === 0, "look not in any draft reads pushed:false, []");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Event.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

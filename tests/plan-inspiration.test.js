// P1+P2+P6 — PLAN / SNAPSHOTS / COMPOSER test. Run: node tests/plan-inspiration.test.js
// Covers: one-plan-per-lead auto-create, look add w/ display snapshot (decor +
// upload), whitelisted patch, reactions (voices, heart echo on love), mood
// reactions, publish (options + reveal + freeze semantics — catalog edits
// never rewrite published content), snapshot reads, moods read, reveal shape.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Decor = require("../models/Decor");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const PlanService = require("../services/PlanService");
const PlanSnapshotService = require("../services/PlanSnapshotService");
const PlanComposerService = require("../services/PlanComposerService");

const TAG = `planinsp-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], decors: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
      leadBrief: { text: "They dream of a royal palace wedding. Gold and maroon everywhere. The bride wants a garden morning haldi." },
      qualificationData: { eventDate: "2026-12-10", city: "Bangalore", eventDays: [{ date: "2026-12-09", functions: [{ type: "Sangeet", time: "19:00", venue: "TBD" }] }] },
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Mandap", name: `${TAG}-mandap`, unit: "unit", tags: ["royal", "gold"],
      image: "m.jpg", thumbnail: "m-thumb.jpg", rating: 0, productVisibility: true,
      productTypes: [{ name: "Standard", costPrice: 40000, sellingPrice: 80000 }],
    });
    created.decors.push(decor._id);

    // ── one plan per lead, auto-created ──
    const p1 = await PlanService.getPlan(lead._id);
    const p2 = await PlanService.getPlan(lead._id);
    ok(String(p1._id) === String(p2._id), "GET auto-creates ONE plan (idempotent)");
    ok((await LeadPlan.countDocuments({ leadId: lead._id })) === 1, "unique per lead");

    // ── looks: decor snapshot + upload ──
    const look = await PlanService.addLook(lead._id, { source: "decor", decorId: decor._id, functionKey: "sangeet", categoryKey: "mandap" }, admin._id);
    ok(look.snapshot.name === `${TAG}-mandap` && look.snapshot.image === "m-thumb.jpg", "decor look snapshots name+image at add");
    ok(look.snapshot.priceChip === "₹80,000", `price chip snapshotted (${look.snapshot.priceChip})`);
    const up = await PlanService.addLook(lead._id, { source: "upload", imageUrl: "https://x/insp.jpg" }, admin._id);
    ok(up.imageUrl === "https://x/insp.jpg" && up.snapshot.image === "https://x/insp.jpg", "upload look carries its image");
    let bad = null;
    try { await PlanService.addLook(lead._id, { source: "decor" }, admin._id); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "decor look without decorId → 400");

    // ── patch (whitelist) ──
    const patched = await PlanService.patchLook(lead._id, look._id, { shortlisted: true, talkingPoint: "The gold pillars echo the palace look", round: 2 });
    ok(patched.shortlisted === true && patched.round === 2 && /gold pillars/.test(patched.talkingPoint), "shortlist/talkingPoint/round patch");

    // ── reactions + the heart echo ──
    await PlanService.reactToLook(lead._id, look._id, { kind: "love", voice: "couple", name: "Priya", note: "THIS one" }, {});
    await PlanService.reactToLook(lead._id, look._id, { kind: "pass", voice: "family", name: "Aunty" }, {});
    const wReact = await PlanService.reactToLook(lead._id, look._id, { kind: "love" }, { adminId: admin._id });
    ok(wReact.reactions.length === 3, "reactions accumulate");
    ok(wReact.reactions[2].voice === "wedsy", "admin reaction defaults to the wedsy voice");
    const hearts = await LeadActivityEvent.find({ leadId: lead._id, kind: "heart" }).lean();
    ok(hearts.length === 2, "love reactions echo hearts (pass does not)");
    ok(hearts.some((h) => h.voice === "couple" && /Priya/.test(h.text)), "couple heart carries the reactor's name");

    // ── mood reactions ──
    await PlanService.reactToMood(lead._id, { moodId: "royal-heritage", kind: "love", voice: "couple", name: "Priya" }, {});
    const planNow = await PlanService.getPlan(lead._id);
    ok(planNow.moodReactions.length === 1 && planNow.moodReactions[0].moodId === "royal-heritage", "mood reaction stored");

    // ── publish: options (shortlisted) + freeze semantics ──
    const snap = await PlanSnapshotService.publish(lead._id, { kind: "options", title: "Round 2 picks", pricingVisible: false, forDecision: true }, admin._id);
    ok(snap.content.looks.length === 1 && snap.content.looks[0].name === `${TAG}-mandap`, "options snapshot embeds ONLY shortlisted looks");
    ok(snap.forDecision === true && snap.pricingVisible === false, "flags stored");
    // catalog edit AFTER publish must not rewrite the frozen content
    await Decor.updateOne({ _id: decor._id }, { $set: { name: "RENAMED" } });
    const frozen = await PlanSnapshotService.get(lead._id, snap._id);
    ok(frozen.content.looks[0].name === `${TAG}-mandap`, "the membrane holds — catalog edits never touch published content");
    // publish echoes onto the activity spine
    const pubEvents = await LeadActivityEvent.find({ leadId: lead._id, kind: "other" }).lean();
    ok(pubEvents.length === 1 && pubEvents[0].voice === "wedsy" && pubEvents[0].meta.snapshotKind === "options", "publish echoes a wedsy activity event");
    // reveal publish freezes blocks verbatim
    const reveal = await PlanSnapshotService.publish(lead._id, { kind: "reveal", blocks: [{ kind: "cover", title: "Us" }] }, admin._id);
    ok(reveal.content.blocks.length === 1 && reveal.content.blocks[0].title === "Us", "reveal blocks frozen verbatim");
    const listMeta = await PlanSnapshotService.list(lead._id);
    ok(listMeta.length === 2 && listMeta[0].content === undefined, "snapshot list is metadata-only, newest first");
    let empty = null;
    try { await PlanSnapshotService.publish(lead._id, { kind: "options", lookIds: [String(up._id)] }, admin._id); } catch (e) { empty = e; }
    ok(empty === null, "explicit lookIds publish works even when unshortlisted");

    // ── P6: moods + reveal composer ──
    const moods = await PlanComposerService.moodsFor();
    ok(moods.length >= 6 && moods.every((m) => m.id && m.name && m.poem !== undefined), "mood library seeded + active-filtered");
    const composed = await PlanComposerService.reveal(lead._id);
    const kinds = composed.autoBlocks.map((b) => b.kind);
    ok(kinds.includes("cover") && kinds.includes("platform"), "reveal always carries cover + platform blocks");
    ok(kinds.includes("heard-you") && composed.autoBlocks.find((b) => b.kind === "heard-you").quotes.length >= 1, "heard-you pull-quotes from the brief (AI or fallback)");
    ok(kinds.includes("story") && composed.autoBlocks.find((b) => b.kind === "story").moods.some((m) => m.id === "royal-heritage"), "story block carries the LOVED moods");
    ok(kinds.includes("journey"), "journey block from discovery days");
    ok(Array.isArray(composed.suggestions.venues) && Array.isArray(composed.suggestions.decorSparks), "suggestions legs present (possibly empty)");
    ok(composed.suggestions.decorSparks.length >= 1, "style words (royal/gold) surface decor sparks");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await PlanSnapshot.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
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

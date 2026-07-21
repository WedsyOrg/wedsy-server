// ADDENDUM A5–A8 test. Run: node tests/planner-addendum-build.test.js
// Covers: the finalise gate (empty-day 422 + selectionComplete override),
// lock 409 on writes + unlock + lane feed on finalise, per-draft publish
// freeze (full fidelity, admin_notes excluded) + dirty flag + revoke +
// couple-facing frozen read, the 5-draft cap, push-to-build (copy, shortlist
// intact), copy/move independence, multi-target add, and Log Work (net brief,
// net-zero churn, italic+plain commit, heartbeat, watermark).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const AdminNotification = require("../models/AdminNotification");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DealDiscount = require("../models/DealDiscount");
const DraftEventService = require("../services/DraftEventService");
const PlanService = require("../services/PlanService");
const LogWorkService = require("../services/LogWorkService");

const TAG = `addbuild-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], decors: [], events: [], lanes: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-meera`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}o@x.com`, phone: `${TAG}o`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id, owner._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: owner._id,
    });
    created.leads.push(lead._id);
    const lane = await LeadLane.create({ leadId: lead._id, key: "decor", name: "Decor", state: "active", ownerId: admin._id });
    created.lanes.push(lane._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productVisibility: true, productTypes: [{ name: "Standard", costPrice: 30000, sellingPrice: 60000 }],
    });
    created.decors.push(decor._id);

    // ── A7: 5-draft cap ──
    const names = ["Royal", "Signature", "Essential", "Fourth", "Fifth"];
    const drafts = [];
    for (const n of names) {
      const d = await DraftEventService.createDraft(lead._id, { name: n }, admin._id);
      drafts.push(d);
      created.events.push(d._id);
    }
    ok(drafts.length === 5, "five drafts allowed (cap raised from 3)");
    let cap = null;
    try { await DraftEventService.createDraft(lead._id, { name: "Sixth" }, admin._id); } catch (e) { cap = e; }
    ok(cap && cap.status === 422 && /5 drafts/.test(cap.message), "the sixth draft is refused");

    const royal = drafts[0];
    const signature = drafts[1];
    const day = await DraftEventService.addDay(lead._id, royal._id, { name: "Sangeet" }, admin._id);
    const item = await DraftEventService.addItem(lead._id, royal._id, day._id, {
      decorId: decor._id, quantity: 1, user_notes: "Couple loves the arch", admin_notes: "margin is tight here",
      addOns: [{ name: "Lights", price: 1000 }],
    }, admin._id);
    ok(item.price === 61000, "item priced (base + add-on)");

    // ── A7: multi-target add + copy independence ──
    const sigDay = await DraftEventService.addDay(lead._id, signature._id, { name: "Sangeet" }, admin._id);
    const multi = await DraftEventService.addItemMulti(lead._id, royal._id, day._id, { decorId: decor._id, quantity: 2 }, [String(signature._id)], admin._id);
    ok(multi.replicated.length === 1 && multi.replicated[0].draftId === String(signature._id), "multi-target add lands in both drafts");
    ok(multi.replicated[0].itemId !== String(multi.item._id), "the replica is an INDEPENDENT copy (fresh _id)");
    // edit Royal's copy — Signature untouched
    await DraftEventService.patchItem(lead._id, royal._id, day._id, multi.item._id, { quantity: 5 }, admin._id);
    const sigEvent = await DraftEventService.getDraft(lead._id, signature._id);
    const sigItem = sigEvent.eventDays.id(sigDay._id).decorItems.id(multi.replicated[0].itemId);
    ok(sigItem.quantity === 2, "a change in Royal never touches Signature (tiering)");

    // copy + move
    const copied = await DraftEventService.copyItem(lead._id, royal._id, day._id, item._id, { toDraftIds: [String(signature._id)] }, admin._id);
    ok(copied.copies.length === 1 && copied.copies[0].itemId !== String(item._id), "copy → independent row in the target draft");
    const moved = await DraftEventService.moveItem(lead._id, royal._id, day._id, item._id, { toDraftId: String(signature._id) }, admin._id);
    ok(!!moved.moved.itemId, "move copies to the target…");
    const royalNow = await DraftEventService.getDraft(lead._id, royal._id);
    ok(!royalNow.eventDays.id(day._id).decorItems.id(item._id), "…and removes from the source");

    // ── A7: push-to-build (copy, shortlist intact) ──
    const look = await PlanService.addLook(lead._id, { source: "decor", decorId: decor._id, functionKey: "sangeet", categoryKey: "stage" }, admin._id);
    await PlanService.patchLook(lead._id, look._id, { shortlisted: true }, admin._id);
    const pushed = await DraftEventService.pushToBuild(lead._id, { lookIds: [String(look._id)], draftIds: [String(royal._id), String(signature._id)] }, admin._id);
    ok(pushed.added === 2 && pushed.shortlistIntact === true, "push-to-build copies into both drafts");
    const planAfter = await LeadPlan.findOne({ leadId: lead._id }).lean();
    ok(planAfter.looks.some((l) => String(l._id) === String(look._id) && l.shortlisted), "the shortlist stays intact (copy, not consume)");

    // ── A5: finalise gate ──
    const empty = drafts[2]; // Essential — no days at all is fine; give it an EMPTY day
    await DraftEventService.addDay(lead._id, empty._id, { name: "Haldi" }, admin._id);
    let gate = null;
    try { await DraftEventService.finalise(lead._id, empty._id, { by: "admin" }, admin._id); } catch (e) { gate = e; }
    ok(gate && gate.status === 422 && /selectionComplete/.test(gate.message), "empty-day draft refuses finalise with the override hint");
    await PlanService.setSelectionComplete(lead._id, true);
    const finalisedEmpty = await DraftEventService.finalise(lead._id, empty._id, { by: "admin" }, admin._id);
    ok(finalisedEmpty.locked === true, "the planner-set selectionComplete flag overrides the soft gate");
    await DraftEventService.unlock(lead._id, empty._id, admin._id);
    await PlanService.setSelectionComplete(lead._id, false);

    // finalise Royal properly (has items) — couple finalise + lane feed
    const fin = await DraftEventService.finalise(lead._id, royal._id, { by: "couple" }, admin._id);
    ok(fin.locked === true && fin.finalisedBy === "couple", "complete draft finalises (couple two-key)");
    ok(fin.laneFeed && fin.laneFeed.value > 0, "finalise feeds the Décor lane (the money membrane)");
    const laneAfter = await LeadLane.findById(lane._id).lean();
    ok(laneAfter.price && laneAfter.price.status === "proposed", "lane price proposed from the finalised draft");

    // lock refuses writes
    let locked = null;
    try { await DraftEventService.addItem(lead._id, royal._id, day._id, { decorId: decor._id }, admin._id); } catch (e) { locked = e; }
    ok(locked && locked.status === 409, "a locked draft refuses item writes (409)");
    await DraftEventService.unlock(lead._id, royal._id, admin._id);
    const afterUnlock = await DraftEventService.addItem(lead._id, royal._id, day._id, { decorId: decor._id, quantity: 1 }, admin._id);
    ok(!!afterUnlock._id, "unlock reopens for amendment");
    const refin = await DraftEventService.finalise(lead._id, royal._id, { by: "admin" }, admin._id);
    ok(refin.locked === true && refin.finalisedBy === "admin", "re-finalise re-locks (amendment cycle)");
    await DraftEventService.unlock(lead._id, royal._id, admin._id);

    // ── A6: publish freeze + fidelity + dirty + revoke ──
    const pub = await DraftEventService.publishDraft(lead._id, signature._id, { pricingVisible: true, coverNote: "Here's Signature" }, admin._id);
    ok(pub.published === true && !!pub.snapshotId, "draft publishes");
    const frozen = await DraftEventService.publishedSnapshotFor(lead._id, signature._id);
    const frozenItems = frozen.content.days.flatMap((d) => d.items).filter((i) => i.kind === "decor");
    ok(frozenItems.every((i) => "addOns" in i && "dimensions" in i && "variant" in i && "notes" in i), "frozen content carries FULL itemized fidelity");
    ok(!JSON.stringify(frozen.content).includes("margin is tight"), "admin_notes (team-only) NEVER reach the frozen content");
    // dirty flag on edit
    await DraftEventService.patchItem(lead._id, signature._id, sigDay._id, multi.replicated[0].itemId, { quantity: 3 }, admin._id);
    const sigAfterEdit = await Event.findById(signature._id).lean();
    ok(sigAfterEdit.hasUnpublishedChanges === true, "editing a published draft raises the update-their-view nudge");
    const frozenStill = await DraftEventService.publishedSnapshotFor(lead._id, signature._id);
    const stillQty = frozenStill.content.days.flatMap((d) => d.items).find((i) => i.quantity === 2);
    ok(!!stillQty, "the couple read stays FROZEN (qty 2) while the live draft moved (qty 3)");
    // re-publish re-freezes
    await DraftEventService.publishDraft(lead._id, signature._id, { pricingVisible: true }, admin._id);
    const refrozen = await DraftEventService.publishedSnapshotFor(lead._id, signature._id);
    ok(refrozen.content.days.flatMap((d) => d.items).some((i) => i.quantity === 3), "re-publish re-freezes the new truth");
    ok((await Event.findById(signature._id).lean()).hasUnpublishedChanges === false, "re-publish clears the nudge");
    // revoke
    await DraftEventService.revokeDraft(lead._id, signature._id, admin._id);
    let gone = null;
    try { await DraftEventService.publishedSnapshotFor(lead._id, signature._id); } catch (e) { gone = e; }
    ok(gone && gone.status === 404, "revoke hides the draft from the couple read");

    // ── A8: log work ──
    const brief1 = await LogWorkService.composeBrief(lead._id);
    ok(/Décor:/.test(brief1.systemBrief) && brief1.changeCount > 0, `net brief composes ("${brief1.systemBrief.slice(0, 90)}…")`);
    const commit1 = await LogWorkService.commit(lead._id, { systemBrief: brief1.systemBrief, plannerAppend: "Also aligned flowers with the caterer." }, admin._id);
    ok(commit1.systemEntry.kind === "auto" && commit1.systemEntry.autoType === "log_work", "system brief posts as the ITALIC-flagged auto entry");
    ok(commit1.appendEntry.kind === "update" && /caterer/.test(commit1.appendEntry.text), "planner append posts as a PLAIN update below");
    const laneBeat = await LeadLane.findById(lane._id).lean();
    ok(+new Date(laneBeat.lastUpdateAt) > +new Date(laneAfter.lastUpdateAt), "logging resets the lane silence clock (heartbeat)");
    ok((await AdminNotification.countDocuments({ leadId: lead._id, type: "plan_log", adminId: owner._id })) === 1, "lead owner soft-notified");
    // net-zero churn
    const churnItem = await DraftEventService.addItem(lead._id, royal._id, day._id, { decorId: decor._id, quantity: 1 }, admin._id);
    await DraftEventService.removeItem(lead._id, royal._id, day._id, churnItem._id, admin._id);
    const brief2 = await LogWorkService.composeBrief(lead._id);
    ok(brief2.systemBrief === LogWorkService.NO_CHANGES, `remove1+add1 churn nets to zero ("${brief2.systemBrief}")`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await PlanSnapshot.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await DealDiscount.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

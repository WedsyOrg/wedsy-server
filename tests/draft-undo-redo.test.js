// DRAFT ITEM-DELETION TOMBSTONES + PERSISTED UNDO/REDO.
// Run: node tests/draft-undo-redo.test.js
// Covers: single delete tombstones (never a hard $pull) → undo restores the
// EXACT day + position → redo re-removes; bulk remove-not-included takes only
// includedInTotal===false decor and is ONE undo step; a new delete clears the
// redo stack; the stacks cap at 50; duplicate with includeNotIncluded false/true;
// tombstones/stacks never copied into a duplicate; totals reconcile after every
// op; undo/redo on an empty stack are 200 no-ops; canUndo/canRedo on the detail
// read; and the version-retry wrapper's retry/rethrow behaviour.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const Category = require("../models/Category");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");

const TAG = `undo-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], cats: [] };
const names = (detail, dayIdx = 0) => detail.days[dayIdx].decorItems.map((i) => i.name);
const detailOf = (leadId, id) => DraftEventService.getDraftDetail(leadId, id);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const cat = await Category.create({ name: `${TAG}-Stage`, order: 1, status: true, adminEventToolView: "single" });
    created.cats.push(cat._id);
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-Couple`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDays: [{ date: "2026-11-20", functions: [{ type: "Mehendi", time: "16:00", venue: "Lawn", pax: "250" }] }] },
    });
    created.leads.push(lead._id);
    const mkDecor = (name, sell) => Decor.create({ category: cat.name, name, unit: "unit", tags: [], image: "x.jpg", thumbnail: "x.jpg", rating: 0, productInfo: { id: "c1" }, productTypes: [{ name: "Standard", costPrice: 100, sellingPrice: sell }] });
    const dA = await mkDecor(`${TAG}-A`, 1000);
    const dB = await mkDecor(`${TAG}-B`, 2000);
    const dC = await mkDecor(`${TAG}-C`, 3000);
    const dD = await mkDecor(`${TAG}-D`, 4000);
    created.decors.push(dA._id, dB._id, dC._id, dD._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Main" }, admin._id);
    created.events.push(draft._id);
    const dayId = (await detailOf(lead._id, draft._id)).days[0].dayId;
    const add = (d, extra = {}) => DraftEventService.addItem(lead._id, draft._id, dayId, { decorId: d._id, quantity: 1, ...extra }, admin._id);
    const a = await add(dA);
    const b = await add(dB);
    const c = await add(dC);
    const d = await add(dD, { includedInTotal: false }); // an ALTERNATIVE
    void a; void c;

    let det = await detailOf(lead._id, draft._id);
    const baseTotal = det.totals.days[0].total;
    ok(names(det).length === 4, "seeded 4 items (A, B, C, D-alternative)");
    ok(baseTotal === 1000 + 2000 + 3000, `alternatives are not in the total (₹${baseTotal})`);
    ok(det.canUndo === false && det.canRedo === false, "a fresh draft reports canUndo/canRedo false");

    // ── SINGLE DELETE → tombstone, not a hard removal ──
    const del = await DraftEventService.removeItem(lead._id, draft._id, dayId, b._id, admin._id);
    ok(del.ok === true && !!del.batchId, "single delete returns ok + a batchId");
    let raw = await Event.findById(draft._id).lean();
    ok(raw.deletedItems.length === 1, "the deleted item is TOMBSTONED, not lost");
    const tomb = raw.deletedItems[0];
    ok(tomb.op === "single" && String(tomb.itemId) === String(b._id) && String(tomb.dayId) === String(dayId),
      "…tombstone carries itemId + dayId + op:single");
    ok(tomb.index === 1, "…and the exact index it sat at (B was position 1)");
    ok(tomb.snapshot && tomb.snapshot.decorPrice === 2000, "…with the FULL subdoc snapshot (snapshot rates preserved)");
    ok(raw.undoStack.length === 1 && raw.redoStack.length === 0, "…batchId pushed onto undoStack; redoStack empty");
    det = await detailOf(lead._id, draft._id);
    ok(names(det).join(",") === `${TAG}-A,${TAG}-C,${TAG}-D`, "…and the item is gone from the day");
    ok(det.totals.days[0].total === baseTotal - 2000, "…totals re-derive without it");
    ok(det.canUndo === true && det.canRedo === false, "…detail reports canUndo true, canRedo false");

    // ── UNDO → exact position ──
    const undone = await DraftEventService.undoDelete(lead._id, draft._id);
    ok(undone.restored === 1, "undo restores 1 item");
    det = await detailOf(lead._id, draft._id);
    ok(names(det).join(",") === `${TAG}-A,${TAG}-B,${TAG}-C,${TAG}-D`, "…back at its EXACT original position (index 1)");
    ok(det.totals.days[0].total === baseTotal, "…totals reconcile to the original");
    ok(det.canUndo === false && det.canRedo === true, "…canUndo false, canRedo true");

    // ── REDO → re-removes ──
    const redone = await DraftEventService.redoDelete(lead._id, draft._id);
    ok(redone.removed === 1, "redo re-removes 1 item");
    det = await detailOf(lead._id, draft._id);
    ok(names(det).join(",") === `${TAG}-A,${TAG}-C,${TAG}-D`, "…the item is tombstoned again");
    ok(det.totals.days[0].total === baseTotal - 2000, "…totals match the post-delete state");
    ok(det.canUndo === true && det.canRedo === false, "…stacks swapped back");

    // restore for the next section
    await DraftEventService.undoDelete(lead._id, draft._id);

    // ── A NEW DELETE CLEARS THE REDO STACK ──
    await DraftEventService.removeItem(lead._id, draft._id, dayId, b._id, admin._id);
    await DraftEventService.undoDelete(lead._id, draft._id);
    raw = await Event.findById(draft._id).lean();
    ok(raw.redoStack.length === 1, "…redo is available after an undo");
    await DraftEventService.removeItem(lead._id, draft._id, dayId, c._id, admin._id); // a NEW delete
    raw = await Event.findById(draft._id).lean();
    ok(raw.redoStack.length === 0, "a NEW delete CLEARS the redo stack");
    await DraftEventService.undoDelete(lead._id, draft._id); // put C back

    // ── BULK remove-not-included = ONE batch ──
    await add(dD, { includedInTotal: false }); // a second alternative
    await add(dA); // an included item that must survive
    await DraftEventService.addCustomItem(lead._id, draft._id, dayId, { name: "LED wall", price: 700 });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, dayId, { title: "Generator", price: 8000, itemRequired: true });
    const before = await detailOf(lead._id, draft._id);
    const beforeTotal = before.totals.days[0].total;
    const bulk = await DraftEventService.removeNotIncluded(lead._id, draft._id, admin._id);
    ok(bulk.removed === 2, `bulk removed both alternatives (${bulk.removed})`);
    det = await detailOf(lead._id, draft._id);
    ok(det.days[0].decorItems.every((i) => i.includedInTotal !== false), "…only includedInTotal===false rows went");
    ok(det.days[0].customItems.length === 1 && det.days[0].mandatoryItems.length === 1,
      "…custom and mandatory rows are never touched");
    ok(det.totals.days[0].total === beforeTotal, "…totals unchanged (alternatives were never summed)");
    raw = await Event.findById(draft._id).lean();
    const bulkTombs = raw.deletedItems.filter((t) => t.batchId === bulk.batchId);
    ok(bulkTombs.length === 2 && bulkTombs.every((t) => t.op === "bulk-not-included"),
      "…both tombstones share ONE batchId, op:bulk-not-included");
    const undoDepth = raw.undoStack.length;
    const undoneBulk = await DraftEventService.undoDelete(lead._id, draft._id);
    ok(undoneBulk.restored === 2, "…and ONE undo step restores both");
    raw = await Event.findById(draft._id).lean();
    ok(raw.undoStack.length === undoDepth - 1, "…consuming exactly one stack entry");
    det = await detailOf(lead._id, draft._id);
    ok(det.days[0].decorItems.filter((i) => i.includedInTotal === false).length === 2, "…both alternatives are back");

    // bulk with nothing to remove is a no-op that does not push a stack entry
    await DraftEventService.removeNotIncluded(lead._id, draft._id, admin._id); // clears them again
    raw = await Event.findById(draft._id).lean();
    const depthBeforeEmpty = raw.undoStack.length;
    const emptyBulk = await DraftEventService.removeNotIncluded(lead._id, draft._id, admin._id);
    ok(emptyBulk.removed === 0, "a bulk remove with nothing to take returns removed:0");
    raw = await Event.findById(draft._id).lean();
    ok(raw.undoStack.length === depthBeforeEmpty, "…and pushes no undo step");

    // ── EMPTY-STACK NO-OPS ──
    const fresh = await DraftEventService.createDraft(lead._id, { name: "Empty" }, admin._id);
    created.events.push(fresh._id);
    const u0 = await DraftEventService.undoDelete(lead._id, fresh._id);
    const r0 = await DraftEventService.redoDelete(lead._id, fresh._id);
    ok(u0.ok === true && u0.restored === 0 && u0.canUndo === false, "undo on an empty stack is a 200 no-op");
    ok(r0.ok === true && r0.removed === 0 && r0.canRedo === false, "redo on an empty stack is a 200 no-op");

    // ── STACK CAP AT 50 ──
    const capDraft = await DraftEventService.createDraft(lead._id, { name: "Cap" }, admin._id);
    created.events.push(capDraft._id);
    const capDay = (await detailOf(lead._id, capDraft._id)).days[0].dayId;
    for (let i = 0; i < 55; i++) {
      const item = await DraftEventService.addItem(lead._id, capDraft._id, capDay, { decorId: dA._id, quantity: 1 }, admin._id);
      await DraftEventService.removeItem(lead._id, capDraft._id, capDay, item._id, admin._id);
    }
    raw = await Event.findById(capDraft._id).lean();
    ok(raw.undoStack.length === 50, `undoStack caps at 50 (55 deletes → ${raw.undoStack.length})`);
    ok(raw.deletedItems.length === 50, "…and orphaned tombstones are pruned with their batch");

    // ── DUPLICATE ──
    const dupSrc = await detailOf(lead._id, draft._id);
    const srcAlts = dupSrc.days[0].decorItems.filter((i) => i.includedInTotal === false).length;
    ok(srcAlts === 0, "duplicate source currently holds no alternatives — re-adding one");
    await add(dD, { includedInTotal: false });
    const srcNow = await detailOf(lead._id, draft._id);
    const srcAll = srcNow.days[0].decorItems.length;
    const srcKept = srcNow.days[0].decorItems.filter((i) => i.includedInTotal !== false).length;

    const dupDefault = await DraftEventService.duplicateDraft(lead._id, draft._id, { name: "Dup default" }, admin._id);
    created.events.push(dupDefault.draft._id);
    let dupDet = await detailOf(lead._id, dupDefault.draft._id);
    ok(dupDet.days[0].decorItems.length === srcKept, `duplicate defaults to includeNotIncluded FALSE (${srcKept} of ${srcAll})`);
    ok(dupDet.days[0].decorItems.every((i) => i.includedInTotal !== false), "…no alternatives copied");
    ok(dupDet.totals.days[0].total === srcNow.totals.days[0].total, "…totals match the source (alternatives never counted)");

    const dupAll = await DraftEventService.duplicateDraft(lead._id, draft._id, { name: "Dup all", includeNotIncluded: true }, admin._id);
    created.events.push(dupAll.draft._id);
    dupDet = await detailOf(lead._id, dupAll.draft._id);
    ok(dupDet.days[0].decorItems.length === srcAll, `includeNotIncluded:true copies all ${srcAll} items`);
    ok(dupDet.days[0].decorItems.filter((i) => i.includedInTotal === false).length === 1, "…including the alternative");

    const dupRaw = await Event.findById(dupAll.draft._id).lean();
    ok(dupRaw.deletedItems.length === 0 && dupRaw.undoStack.length === 0 && dupRaw.redoStack.length === 0,
      "a duplicate starts with NO tombstones and empty stacks");
    ok(dupDet.canUndo === false && dupDet.canRedo === false, "…and reports canUndo/canRedo false");
    ok(!dupRaw.locked && !dupRaw.published, "…and never inherits lock/publish state");
    const srcRaw = await Event.findById(draft._id).lean();
    const srcIds = new Set((srcRaw.eventDays[0].decorItems || []).map((i) => String(i._id)));
    ok((dupRaw.eventDays[0].decorItems || []).every((i) => !srcIds.has(String(i._id))),
      "…every copied subdoc gets a FRESH _id (independent rows)");
    ok(dupRaw.eventDays[0].customItems.length === srcRaw.eventDays[0].customItems.length
      && dupRaw.eventDays[0].mandatoryItems.length === srcRaw.eventDays[0].mandatoryItems.length,
      "…custom and mandatory rows ride along");

    // ── withVersionRetry ──
    let calls = 0;
    const retried = await DraftEventService.withVersionRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("No matching document found for id"), { name: "VersionError" });
      return "ok";
    });
    ok(retried === "ok" && calls === 3, "withVersionRetry retries a VersionError and re-reads (3 attempts)");
    let realErr = null;
    try {
      await DraftEventService.withVersionRetry(async () => { throw Object.assign(new Error("Item not found"), { status: 404 }); });
    } catch (e) { realErr = e; }
    ok(realErr && realErr.status === 404, "…and rethrows a real error (404) immediately, never retrying it");
    let exhausted = null;
    try {
      await DraftEventService.withVersionRetry(async () => { throw Object.assign(new Error("x"), { name: "VersionError" }); }, { attempts: 2 });
    } catch (e) { exhausted = e; }
    ok(exhausted && exhausted.name === "VersionError", "…and surfaces the clash once attempts are exhausted");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Event.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Category.deleteMany({ _id: { $in: created.cats } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

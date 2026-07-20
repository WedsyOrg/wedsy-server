// PLANNER P1 controllers — plan (P1), snapshots (P2), drafts + items (P3/P4),
// discount + lane feed (P5), moods + reveal (P6).
// READ gate: roster/participant (assertInScopeOrRoster + includeParticipants).
// WRITE gate: owner/manager (scopeFilter) OR any lane owner on the lead.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const PlanService = require("../services/PlanService");
const PlanSnapshotService = require("../services/PlanSnapshotService");
const DraftEventService = require("../services/DraftEventService");
const PlanComposerService = require("../services/PlanComposerService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error, fallback = "The planner hiccuped — please retry.") => {
  const status = error.status || 500;
  if (status === 500) console.error("[plan]", error);
  res.status(status).json({ message: status === 500 ? fallback : error.message });
};

const READ = { includeParticipants: true };

const canWrite = async (req, leadId) => {
  if (!mongoose.Types.ObjectId.isValid(String(leadId))) {
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  }
  const inScope = await Enquiry.findOne({ $and: [{ _id: leadId }, req.scopeFilter || {}] }, { _id: 1 }).lean();
  if (inScope) return;
  const lane = await LeadLane.findOne({ leadId, ownerId: req.auth.user_id }, { _id: 1 }).lean();
  if (lane) return;
  throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

const wrap = (fn, fallback) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    respond(res, error, fallback);
  }
};

// ── P1 ────────────────────────────────────────────────────────────────────────
const GetPlan = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ plan: await PlanService.getPlan(req.params._id) });
});
const AddLook = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ look: await PlanService.addLook(req.params._id, req.body || {}, req.auth.user_id) });
});
const PatchLook = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json({ look: await PlanService.patchLook(req.params._id, req.params.lookId, req.body || {}) });
});
const DeleteLook = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await PlanService.removeLook(req.params._id, req.params.lookId));
});
const ReactLook = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(201).json({ look: await PlanService.reactToLook(req.params._id, req.params.lookId, req.body || {}, { adminId: req.auth.user_id }) });
});
const ReactMood = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(201).json({ reaction: await PlanService.reactToMood(req.params._id, req.body || {}, { adminId: req.auth.user_id }) });
});
const PatchPlan = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  if ((req.body || {}).styleSignature === undefined) {
    return res.status(400).json({ message: "Nothing to update (styleSignature)." });
  }
  res.status(200).json(await PlanService.setStyleSignature(req.params._id, req.body.styleSignature));
});

// ── P2 ────────────────────────────────────────────────────────────────────────
const Publish = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ snapshot: await PlanSnapshotService.publish(req.params._id, req.body || {}, req.auth.user_id) });
});
const ListSnapshots = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ list: await PlanSnapshotService.list(req.params._id) });
});
const GetSnapshot = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ snapshot: await PlanSnapshotService.get(req.params._id, req.params.snapshotId) });
});

// Internal seam (the couple app later) — no admin scope, secret-gated at route.
const InternalSnapshots = wrap(async (req, res) => {
  res.status(200).json({ list: await PlanSnapshotService.list(req.params.leadId) });
});
const InternalSnapshot = wrap(async (req, res) => {
  res.status(200).json({ snapshot: await PlanSnapshotService.get(req.params.leadId, req.params.snapshotId) });
});
const InternalReactLook = wrap(async (req, res) => {
  const { resolveLeadId } = require("../services/LeadActivityService");
  const leadId = await resolveLeadId(req.body || {});
  res.status(201).json({ look: await PlanService.reactToLook(leadId, req.body.lookId, req.body || {}, {}) });
});
const InternalReactMood = wrap(async (req, res) => {
  const { resolveLeadId } = require("../services/LeadActivityService");
  const leadId = await resolveLeadId(req.body || {});
  res.status(201).json({ reaction: await PlanService.reactToMood(leadId, req.body || {}, {}) });
});

// ── P3 ────────────────────────────────────────────────────────────────────────
const CreateDraft = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ draft: await DraftEventService.createDraft(req.params._id, req.body || {}, req.auth.user_id) });
});
const ListDrafts = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ drafts: await DraftEventService.listDrafts(req.params._id) });
});

// ── P4 ────────────────────────────────────────────────────────────────────────
const AddDay = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ day: await DraftEventService.addDay(req.params._id, req.params.eventId, req.body || {}) });
});
const AddItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ item: await DraftEventService.addItem(req.params._id, req.params.eventId, req.params.dayId, req.body || {}) });
});
const PatchItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json({ item: await DraftEventService.patchItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId, req.body || {}) });
});
const DeleteItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.removeItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId));
});
const ReorderItems = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.reorderItems(req.params._id, req.params.eventId, req.params.dayId, req.body || {}));
});
const AddPackage = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ package: await DraftEventService.addPackage(req.params._id, req.params.eventId, req.params.dayId, req.body || {}) });
});
const DeletePackage = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.removePackage(req.params._id, req.params.eventId, req.params.dayId, req.params.rowId));
});
const AddCustomItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ item: await DraftEventService.addCustomItem(req.params._id, req.params.eventId, req.params.dayId, req.body || {}) });
});
const AddMandatoryItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ item: await DraftEventService.addMandatoryItem(req.params._id, req.params.eventId, req.params.dayId, req.body || {}) });
});
const PatchSideItem = (kind) =>
  wrap(async (req, res) => {
    await canWrite(req, req.params._id);
    res.status(200).json({ item: await DraftEventService.patchSideItem(req.params._id, req.params.eventId, req.params.dayId, kind, req.params.itemId, req.body || {}) });
  });
const DeleteSideItem = (kind) =>
  wrap(async (req, res) => {
    await canWrite(req, req.params._id);
    res.status(200).json(await DraftEventService.removeSideItem(req.params._id, req.params.eventId, req.params.dayId, kind, req.params.itemId));
  });

// ── P5 ────────────────────────────────────────────────────────────────────────
const GrantDiscount = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ discount: await PlanSnapshotService.grantDiscount(req.params._id, req.params.eventId, req.body || {}, req.auth.user_id) });
});
const ListDiscounts = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ list: await PlanSnapshotService.listDiscounts(req.params._id, req.params.eventId) });
});
const DecideDiscount = wrap(async (req, res) => {
  res.status(200).json({ discount: await PlanSnapshotService.decideDiscount(req.params.id, (req.body || {}).decision, req.auth.user_id) });
});
const FeedDecorLane = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await PlanSnapshotService.feedDecorLane(req.params._id, (req.body || {}).eventId, req.auth.user_id));
});

// ── P6 ────────────────────────────────────────────────────────────────────────
const Moods = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ moods: await PlanComposerService.moodsFor() });
});
const Reveal = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json(await PlanComposerService.reveal(req.params._id));
});

module.exports = {
  GetPlan, AddLook, PatchLook, DeleteLook, ReactLook, ReactMood, PatchPlan,
  Publish, ListSnapshots, GetSnapshot,
  InternalSnapshots, InternalSnapshot, InternalReactLook, InternalReactMood,
  CreateDraft, ListDrafts,
  AddDay, AddItem, PatchItem, DeleteItem, ReorderItems, AddPackage, DeletePackage,
  AddCustomItem, AddMandatoryItem, PatchSideItem, DeleteSideItem,
  GrantDiscount, ListDiscounts, DecideDiscount, FeedDecorLane,
  Moods, Reveal,
};

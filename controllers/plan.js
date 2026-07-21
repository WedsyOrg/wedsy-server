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
  res.status(200).json({ look: await PlanService.patchLook(req.params._id, req.params.lookId, req.body || {}, req.auth.user_id) });
});
const DeleteLook = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await PlanService.removeLook(req.params._id, req.params.lookId, req.auth.user_id));
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
  const body = req.body || {};
  const out = {};
  if (body.styleSignature !== undefined) {
    Object.assign(out, await PlanService.setStyleSignature(req.params._id, body.styleSignature));
  }
  if (body.selectionComplete !== undefined) {
    Object.assign(out, await PlanService.setSelectionComplete(req.params._id, body.selectionComplete));
  }
  if (!Object.keys(out).length) {
    return res.status(400).json({ message: "Nothing to update (styleSignature | selectionComplete)." });
  }
  res.status(200).json(out);
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
// ONE draft with full day→item detail (the list omits items). Roster/participant read.
const GetDraft = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ draft: await DraftEventService.getDraftDetail(req.params._id, req.params.eventId) });
});

// ── P4 ────────────────────────────────────────────────────────────────────────
const AddDay = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ day: await DraftEventService.addDay(req.params._id, req.params.eventId, req.body || {}, req.auth.user_id) });
});
const AddItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  const body = req.body || {};
  // A7 — draftIds[]: write the same product into several drafts at once
  // (independent copies).
  if (Array.isArray(body.draftIds) && body.draftIds.length) {
    return res.status(201).json(
      await DraftEventService.addItemMulti(req.params._id, req.params.eventId, req.params.dayId, body, body.draftIds, req.auth.user_id)
    );
  }
  res.status(201).json({ item: await DraftEventService.addItem(req.params._id, req.params.eventId, req.params.dayId, body, req.auth.user_id) });
});
const PatchItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json({ item: await DraftEventService.patchItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId, req.body || {}, req.auth.user_id) });
});
const DeleteItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.removeItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId, req.auth.user_id));
});
const ReorderItems = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.reorderItems(req.params._id, req.params.eventId, req.params.dayId, req.body || {}));
});
const AddPackage = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json({ package: await DraftEventService.addPackage(req.params._id, req.params.eventId, req.params.dayId, req.body || {}, req.auth.user_id) });
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

// ── ADDENDUM A1–A8 ───────────────────────────────────────────────────────────
const ThemeService = require("../services/ThemeService");
const LogWorkService = require("../services/LogWorkService");

const SelectTheme = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json({ selectedThemes: await PlanService.selectTheme(req.params._id, req.body || {}, req.auth.user_id) });
});
const MoreRequests = wrap(async (req, res) => {
  await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, READ);
  res.status(200).json({ list: await PlanService.listMoreRequests(req.params._id, { includeFulfilled: req.query.includeFulfilled === "1" }) });
});
const InternalMoreOptions = wrap(async (req, res) => {
  res.status(201).json({ request: await PlanService.requestMoreOptions(req.body || {}) });
});
const ThemesList = wrap(async (req, res) => {
  res.status(200).json({ themes: await ThemeService.list({ eventType: req.query.eventType }) });
});
const ThemeCatalogue = wrap(async (req, res) => {
  res.status(200).json(await ThemeService.catalogue(req.params.themeId, { categoryKey: req.query.categoryKey, limit: req.query.limit }));
});
const PresentPublish = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  const out = await PlanSnapshotService.publishPresent(req.params._id, req.body || {}, req.auth.user_id);
  res.status(201).json(out);
});
const FinaliseDraft = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.finalise(req.params._id, req.params.eventId, req.body || {}, req.auth.user_id));
});
const UnlockDraft = wrap(async (req, res) => {
  // Owner/manager ONLY — the deliberate deal-value reopen (no lane-owner path).
  const inScope = await Enquiry.findOne({ $and: [{ _id: req.params._id }, req.scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) return res.status(403).json({ message: "Unlock is the lead owner's / manager's call." });
  res.status(200).json(await DraftEventService.unlock(req.params._id, req.params.eventId, req.auth.user_id));
});
const PublishDraft = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.publishDraft(req.params._id, req.params.eventId, req.body || {}, req.auth.user_id));
});
const RevokeDraft = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.revokeDraft(req.params._id, req.params.eventId, req.auth.user_id));
});
const InternalPublishedDraft = wrap(async (req, res) => {
  res.status(200).json({ snapshot: await DraftEventService.publishedSnapshotFor(req.params.leadId, req.params.eventId) });
});
const PushToBuild = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.pushToBuild(req.params._id, req.body || {}, req.auth.user_id));
});
const CopyItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.copyItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId, req.body || {}, req.auth.user_id));
});
const MoveItem = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await DraftEventService.moveItem(req.params._id, req.params.eventId, req.params.dayId, req.params.itemId, req.body || {}, req.auth.user_id));
});
const LogWorkCompose = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(200).json(await LogWorkService.composeBrief(req.params._id));
});
const LogWorkCommit = wrap(async (req, res) => {
  await canWrite(req, req.params._id);
  res.status(201).json(await LogWorkService.commit(req.params._id, req.body || {}, req.auth.user_id));
});

module.exports = {
  GetPlan, AddLook, PatchLook, DeleteLook, ReactLook, ReactMood, PatchPlan,
  SelectTheme, MoreRequests, InternalMoreOptions, ThemesList, ThemeCatalogue,
  PresentPublish, FinaliseDraft, UnlockDraft, PublishDraft, RevokeDraft, InternalPublishedDraft,
  PushToBuild, CopyItem, MoveItem, LogWorkCompose, LogWorkCommit,
  Publish, ListSnapshots, GetSnapshot,
  InternalSnapshots, InternalSnapshot, InternalReactLook, InternalReactMood,
  CreateDraft, ListDrafts, GetDraft,
  AddDay, AddItem, PatchItem, DeleteItem, ReorderItems, AddPackage, DeletePackage,
  AddCustomItem, AddMandatoryItem, PatchSideItem, DeleteSideItem,
  GrantDiscount, ListDiscounts, DecideDiscount, FeedDecorLane,
  Moods, Reveal,
};

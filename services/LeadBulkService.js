const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const ActivityLogService = require("./ActivityLogService");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const MAX = 200;

// Validate the id list + verify EVERY lead is within the caller's scope (mirrors
// LeadLifecycleService.bulkTransfer — out-of-scope ⇒ the whole batch is rejected).
const assertScopedIds = async (leadIds, scopeFilter) => {
  if (!Array.isArray(leadIds) || leadIds.length === 0) throw httpError(400, "leadIds must be a non-empty array");
  if (leadIds.length > MAX) throw httpError(400, `Max ${MAX} leads per action`);
  for (const id of leadIds) if (!isId(id)) throw httpError(400, `Invalid lead id: ${id}`);
  const inScope = await Enquiry.find({ $and: [{ _id: { $in: leadIds } }, scopeFilter || {}] }, { _id: 1 }).lean();
  const inScopeIds = new Set(inScope.map((l) => String(l._id)));
  const out = leadIds.filter((id) => !inScopeIds.has(String(id)));
  if (out.length) throw httpError(403, `Out of your scope: ${out.length} lead(s) — batch rejected`);
  return leadIds;
};

const audit = async (actorId, action, leadIds, meta) => {
  for (const id of leadIds) {
    await ActivityLogService.record({ actorId, action, entityType: "lead", entityId: String(id), summary: meta.summary, meta });
  }
};

// Add or remove a tag across the selection (atomic $addToSet / $pull).
const bulkTag = async ({ leadIds, tag, mode = "add" } = {}, actorId, scopeFilter) => {
  const clean = String(tag || "").trim();
  if (!clean) throw httpError(400, "A tag is required");
  await assertScopedIds(leadIds, scopeFilter);
  const update = mode === "remove" ? { $pull: { tags: clean } } : { $addToSet: { tags: clean } };
  await Enquiry.updateMany({ _id: { $in: leadIds } }, update);
  await audit(actorId, "bulk_tag", leadIds, { summary: `${mode === "remove" ? "Removed" : "Added"} tag "${clean}"`, tag: clean, mode });
  return { updated: leadIds.length, tag: clean, mode };
};

// Move the selection to a stage. Terminal stages are REJECTED: a bulk write to
// "won"/"lost" bypasses the whole state machine (qualified/isLost/Project/
// Onboarding never get touched), manufacturing divergent-truth leads that show
// in the Won tab but vanish from every funnel metric.
const bulkStage = async ({ leadIds, stage } = {}, actorId, scopeFilter) => {
  const clean = String(stage || "").trim();
  if (!clean) throw httpError(400, "A stage is required");
  if (["won", "lost"].includes(clean)) {
    throw httpError(422, "Terminal stages can't be set in bulk — use the lead's own onboard/disqualify flow");
  }
  await assertScopedIds(leadIds, scopeFilter);
  // Signal spine: a bulk stage move is employee activity on each lead ($max
  // keeps the stamp monotonic, matching touchLastActivity's semantics).
  await Enquiry.updateMany(
    { _id: { $in: leadIds } },
    { $set: { stage: clean, updatedBy: actorId || null }, $max: { lastActivityAt: new Date() } }
  );
  for (const id of leadIds) {
    await LeadInternalEventService.record({ leadId: id, type: "stage_changed", actorId, payload: { stage: clean, bulk: true } });
  }
  await audit(actorId, "bulk_stage", leadIds, { summary: `Moved to stage "${clean}"`, stage: clean });
  return { updated: leadIds.length, stage: clean };
};

// Mark the selection lost (a direct managerial action — distinct from the
// single-lead request/approve disqualify flow). Sets the approved-lost state.
const bulkLost = async ({ leadIds, reason = "" } = {}, actorId, scopeFilter) => {
  await assertScopedIds(leadIds, scopeFilter);
  const now = new Date();
  await Enquiry.updateMany(
    { _id: { $in: leadIds } },
    { $set: { isLost: true, lostStatus: "approved", lostReason: String(reason || "").slice(0, 200), lostDecidedBy: actorId || null, lostDecidedAt: now, updatedBy: actorId || null } }
  );
  for (const id of leadIds) {
    await LeadInternalEventService.record({ leadId: id, type: "transferred", actorId, payload: { reason: "bulk_lost", lostReason: reason || "" } });
  }
  await audit(actorId, "bulk_lost", leadIds, { summary: `Marked lost${reason ? ` (${reason})` : ""}`, reason });
  return { updated: leadIds.length };
};

// SOFT DELETE — recoverable. Sets archivedAt/archivedBy; NEVER hard-removes.
// Route-gated to leads:delete:all (founder) on top of this.
const bulkArchive = async ({ leadIds } = {}, actorId, scopeFilter) => {
  await assertScopedIds(leadIds, scopeFilter);
  await Enquiry.updateMany({ _id: { $in: leadIds } }, { $set: { archivedAt: new Date(), archivedBy: actorId || null } });
  await audit(actorId, "bulk_archive", leadIds, { summary: "Soft-deleted (archived, recoverable)" });
  return { archived: leadIds.length };
};

module.exports = { assertScopedIds, bulkTag, bulkStage, bulkLost, bulkArchive };

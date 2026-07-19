// L4 — QUOTE-REQUEST QUEUE. The couple's "send for quote" lands here through
// the internal ingest seam; the Store/CS teams work it from the workspace
// queue. A pending request also raises a needs-attention notification to the
// LEAD OWNER and drops a decor-lane auto entry (fire-safe, never blocks the
// ingest).
const mongoose = require("mongoose");
const QuoteRequest = require("../models/QuoteRequest");
const Enquiry = require("../models/Enquiry");
const AdminNotificationService = require("./AdminNotificationService");
const LeadLaneService = require("./LeadLaneService");
const { filterAssignableIds } = require("../utils/assignable");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const ingest = async ({ leadId, userId, phone, draftName, itemCount, payload, sentAt } = {}) => {
  // Resolve the lead when possible; a userId-only row is still queued (the
  // workspace read carries it; the lead link back-fills when resolvable).
  let resolvedLeadId = null;
  try {
    const { resolveLeadId } = require("./LeadActivityService");
    resolvedLeadId = await resolveLeadId({ leadId, userId, phone });
  } catch (e) {
    if (!userId || !isId(userId)) throw e; // nothing to anchor the request to
  }

  const doc = await QuoteRequest.create({
    leadId: resolvedLeadId,
    userId: userId && isId(userId) ? userId : null,
    draftName: String(draftName || "").slice(0, 200),
    itemCount: Number.isFinite(Number(itemCount)) ? Number(itemCount) : 0,
    payload: payload && typeof payload === "object" ? payload : {},
    sentAt: sentAt ? new Date(sentAt) : new Date(),
  });

  if (resolvedLeadId) {
    // Activity spine — the quote_sent moment (couple voice).
    try {
      const LeadActivityService = require("./LeadActivityService");
      await LeadActivityService.ingest({
        leadId: resolvedLeadId,
        userId,
        kind: "quote_sent",
        meta: { draftName: doc.draftName, itemCount: doc.itemCount, quoteRequestId: String(doc._id) },
        voice: "couple",
      });
    } catch (e) {
      console.error("[QuoteRequest] activity echo failed:", e.message);
    }
    // Needs-attention → the lead owner (assignable only).
    try {
      const lead = await Enquiry.findById(resolvedLeadId, { name: 1, assignedTo: 1 }).lean();
      const recipients = lead && lead.assignedTo ? await filterAssignableIds([lead.assignedTo]) : [];
      if (recipients.length) {
        await AdminNotificationService.notify(recipients, {
          type: "quote_request",
          title: `${lead.name} sent picks for quote`,
          message: `${doc.draftName || "A draft"} · ${doc.itemCount} item${doc.itemCount === 1 ? "" : "s"} — price it from the quote queue.`,
          leadId: resolvedLeadId,
          payload: { quoteRequestId: String(doc._id) },
        });
      }
      // Decor-lane echo (auto entry by lane KEY; no-op when the lane doesn't exist).
      await LeadLaneService.autoEntry(
        resolvedLeadId,
        "decor",
        "",
        `Quote request — ${doc.draftName || "draft"} (${doc.itemCount} item${doc.itemCount === 1 ? "" : "s"})`
      );
    } catch (e) {
      console.error("[QuoteRequest] notify/lane echo failed:", e.message);
    }
  }
  return doc.toObject();
};

const listForLead = async (leadId, { status } = {}) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const q = { leadId };
  if (["pending", "priced", "dismissed"].includes(status)) q.status = status;
  return { list: await QuoteRequest.find(q).sort({ sentAt: -1 }).lean() };
};

// Workspace queue — newest pending first (Store/CS teams).
const listQueue = async ({ status = "pending", limit } = {}) => {
  const q = {};
  if (["pending", "priced", "dismissed"].includes(status)) q.status = status;
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const list = await QuoteRequest.find(q).sort({ sentAt: -1 }).limit(lim).lean();
  const leadIds = [...new Set(list.map((r) => String(r.leadId || "")).filter(Boolean))];
  const leads = leadIds.length ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, assignedTo: 1 }).lean() : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  return {
    list: list.map((r) => ({
      ...r,
      leadName: r.leadId ? (leadById.get(String(r.leadId)) || {}).name || null : null,
    })),
  };
};

// PATCH — status only (whitelisted); priced stamps pricedBy/At.
const patchStatus = async (id, status, actorId) => {
  if (!isId(id)) throw err(400, "Invalid id");
  if (!["pending", "priced", "dismissed"].includes(status)) {
    throw err(400, 'status must be "pending", "priced" or "dismissed"');
  }
  const doc = await QuoteRequest.findById(id);
  if (!doc) throw err(404, "Quote request not found");
  const set = { status };
  if (status === "priced") {
    set.pricedBy = actorId || null;
    set.pricedAt = new Date();
  }
  await QuoteRequest.updateOne({ _id: doc._id }, { $set: set });
  return await QuoteRequest.findById(doc._id).lean();
};

module.exports = { ingest, listForLead, listQueue, patchStatus };

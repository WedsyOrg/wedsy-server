const mongoose = require("mongoose");
const LeadChatMessage = require("../models/LeadChatMessage");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const EnquiryRepository = require("../repositories/EnquiryRepository");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const MAX_BODY = 5000;

// Ritual notes the journey strip misrouted into this chat store — every
// "[Kickoff|Meetings|Lead comms|Proposal|Agreement|Onboard] …" body. They are
// NOTES, not team messages: the chat rail (and its unread counts) must never
// show them — NoteStreamService surfaces them in the merged note stream
// instead. Read-time exclusion, anchored at the start (a mid-body "[Proposal]"
// mention stays a chat message); no migration.
const { RITUAL_NOTE_PREFIX_RE } = require("../utils/ritualNotePrefixes");
const notRitualNoteFilter = () => ({ body: { $not: { $regex: RITUAL_NOTE_PREFIX_RE } } });
const cleanAttachments = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && ["image", "pdf"].includes(a.type) && typeof a.url === "string" && a.url.trim())
    .slice(0, 10)
    .map((a) => ({ type: a.type, url: String(a.url).trim(), name: String(a.name || "").slice(0, 200) }));
};
const cleanMentions = (raw, exclude) => {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const m of raw) {
    if (isId(m) && String(m) !== String(exclude)) set.add(String(m));
  }
  return [...set];
};

// Enrich a page of messages with author names (one query).
const withAuthors = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.authorId).filter(Boolean).map(String))];
  const admins = ids.length ? await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean() : [];
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));
  return rows.map((r) => ({
    ...r,
    authorName: r.authorId ? nameOf.get(String(r.authorId)) || "—" : "System",
  }));
};

// GET — paginated (newest first), and marks the page read for the caller.
const listMessages = async (leadId, callerId, { limit = 30, before } = {}) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const filter = { leadId, ...notRitualNoteFilter() };
  if (before && isId(before)) {
    const cursor = await LeadChatMessage.findById(before, { createdAt: 1 }).lean();
    if (cursor) filter.createdAt = { $lt: cursor.createdAt };
  }
  const rows = await LeadChatMessage.find(filter).sort({ createdAt: -1 }).limit(lim + 1).lean();
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);

  // Mark read: add the caller to readBy on any returned message they haven't read.
  if (callerId) {
    await LeadChatMessage.updateMany(
      { leadId, readBy: { $ne: callerId } },
      { $addToSet: { readBy: callerId } }
    );
  }

  const enriched = await withAuthors(page);
  // Return oldest-first for rendering convenience.
  return { messages: enriched.reverse(), hasMore };
};

const unreadCountForLead = async (leadId, adminId) =>
  LeadChatMessage.countDocuments({
    leadId,
    authorId: { $ne: adminId },
    readBy: { $ne: adminId },
    ...notRitualNoteFilter(),
  });

// ── Internal-chat notification (additive) ────────────────────────────────────
// A human teammate posted on a lead's back-room thread → tell the thread.
// SECOND notification path, not a replacement: @mentioned people keep getting
// `chat_mention` above and are excluded here, so nobody is told twice.
//
// Recipient set, in order:
//   1. chatMembers(leadId) ∪ { lead.assignedTo } — the phase-gated participants
//      (pre-qual: assignee + their reporting manager; post-qual: the roster),
//      UNION the current owner. The union matters: the qualify hinge rosters the
//      OUTGOING owner as "qualifier" and never auto-adds the incoming one, so the
//      roster alone can miss the very person who owns the lead.
//   2. minus the sender.
//   3. minus this message's mentions[] (they have chat_mention) — the dedupe.
//   4. non-empty → notify.
//   5. empty → owner + owner's reportingManagerId + revenueHeadIds(), minus sender.
//   6. still empty → nothing to write; logged, never thrown.
// Reuses chatMembers / Admin.reportingManagerId / TriageService.revenueHeadIds
// rather than re-deriving any of them. TriageService is lazy-required to match
// the late-require pattern used elsewhere for it and dodge load-order coupling.
const notifyThreadOfMessage = async (leadId, authorId, msg, text, ments) => {
  try {
    if (!msg || msg.kind === "system") return; // belt-and-braces: system never notifies
    const lead = await Enquiry.findById(leadId, { name: 1, assignedTo: 1 }).lean();
    if (!lead) return;

    const sender = String(authorId || "");
    const mentioned = new Set((ments || []).map(String));
    const prune = (set) => {
      set.delete(sender);
      mentioned.forEach((m) => set.delete(m));
      return set;
    };

    // 1 — participants ∪ current owner
    const ids = new Set();
    try {
      for (const m of await chatMembers(leadId)) ids.add(String(m._id));
    } catch (e) {
      // chatMembers throws only on a bad/missing lead; the fallback below covers it.
      console.error("[LeadChat] chatMembers lookup failed:", e.message);
    }
    if (lead.assignedTo) ids.add(String(lead.assignedTo));

    // 2 + 3
    prune(ids);

    // 5 — fallback: the owner and the person above them, plus the revenue heads.
    // Pruned exactly like the primary set: a mentioned person already has their
    // chat_mention and must never also get chat_internal, via ANY path. If that
    // re-empties the set, the log-and-skip below is the right outcome — everyone
    // who would have been told was told already.
    if (!ids.size) {
      if (lead.assignedTo) {
        ids.add(String(lead.assignedTo));
        const owner = await Admin.findById(lead.assignedTo, { reportingManagerId: 1 }).lean();
        if (owner && owner.reportingManagerId) ids.add(String(owner.reportingManagerId));
      }
      // revenueHeadIds() is unioned here, so step 6 ("revenue heads alone") is
      // already satisfied by this branch when there is no owner/manager.
      for (const id of await require("./TriageService").revenueHeadIds()) ids.add(String(id));
      prune(ids);
    }

    if (!ids.size) {
      console.warn(
        `[LeadChat] no recipient for internal message on lead ${leadId} — ` +
          "no participants, no owner, no manager, and no Revenue Head role; nothing written."
      );
      return;
    }

    const author = await Admin.findById(authorId, { name: 1 }).lean();
    await AdminNotificationService.notify([...ids], {
      type: "chat_internal",
      title: `${author ? author.name : "Someone"} messaged on ${lead.name || "a lead"}`,
      message: text.slice(0, 160),
      leadId,
      payload: { messageId: String(msg._id) },
    });
  } catch (e) {
    console.error("[LeadChat] internal-chat notification failed:", e.message);
  }
};

const postMessage = async (leadId, authorId, { body, attachments, mentions } = {}) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const text = typeof body === "string" ? body.trim() : "";
  const atts = cleanAttachments(attachments);
  if (!text && !atts.length) throw httpError(400, "A message needs text or an attachment");
  if (text.length > MAX_BODY) throw httpError(400, `Message too long (max ${MAX_BODY})`);
  const ments = cleanMentions(mentions, authorId);

  const isFirst = (await LeadChatMessage.countDocuments({ leadId })) === 0;

  const msg = await LeadChatMessage.create({
    leadId,
    authorId,
    kind: "message",
    body: text,
    attachments: atts,
    mentions: ments,
    readBy: [authorId], // the author has implicitly read their own message
  });

  // Lightweight journey marker — once per thread, not per message.
  if (isFirst) {
    await LeadInternalEventService.record({
      leadId,
      type: "chat_started",
      actorId: authorId,
      payload: {},
    });
  }

  // @mentions → a DISTINCT notification, separate from normal activity.
  if (ments.length) {
    const author = await Admin.findById(authorId, { name: 1 }).lean();
    const lead = await Enquiry.findById(leadId, { name: 1 }).lean();
    await AdminNotificationService.notify(ments, {
      type: "chat_mention",
      title: `${author ? author.name : "Someone"} mentioned you on ${lead ? lead.name : "a lead"}`,
      message: text.slice(0, 160),
      leadId,
      payload: { messageId: String(msg._id) },
    });
  }

  // Everyone else on the thread → chat_internal. Additive second path; the
  // mention block above is untouched. Self-contained try/catch inside, so a
  // notification failure can never break the post.
  await notifyThreadOfMessage(leadId, authorId, msg, text, ments);

  // Signal spine: a HUMAN chat message is employee activity (touched only —
  // internal chatter is never a customer response). System messages don't
  // touch: they narrate actions whose services already stamped the spine.
  await EnquiryRepository.touchLastActivity(leadId);

  const [enriched] = await withAuthors([msg.toObject()]);
  return enriched;
};

// System message — task lifecycle narration (Slice 2) + nurture (Slice 4) +
// MB8b step-note mirror. `stepId` links the chat echo back to a step; `mentions`
// carries the original note's @tags so chat_mention notifications still fire
// even though the message itself is authored by the system.
const postSystemMessage = async (
  leadId,
  { body, systemType = "", taskId = null, stepId = null, followupId = null, mentions = [] } = {}
) => {
  if (!isId(leadId)) return null;
  const ments = Array.isArray(mentions) ? mentions.filter((m) => isId(m)).map(String) : [];
  const msg = await LeadChatMessage.create({
    leadId,
    authorId: null,
    kind: "system",
    systemType,
    body: String(body || "").slice(0, MAX_BODY),
    taskId: taskId && isId(taskId) ? taskId : null,
    stepId: stepId && isId(stepId) ? stepId : null,
    followupId: followupId && isId(followupId) ? followupId : null,
    mentions: ments,
  });
  return msg;
};

const editMessage = async (messageId, authorId, { body } = {}) => {
  if (!isId(messageId)) throw httpError(400, "Invalid messageId");
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw httpError(400, "Message cannot be empty");
  const msg = await LeadChatMessage.findOne({ _id: messageId, authorId, kind: "message" });
  if (!msg) throw httpError(404, "Message not found or not yours");
  msg.body = text.slice(0, MAX_BODY);
  msg.editedAt = new Date();
  await msg.save();
  const [enriched] = await withAuthors([msg.toObject()]);
  return enriched;
};

const deleteMessage = async (messageId, authorId) => {
  if (!isId(messageId)) throw httpError(400, "Invalid messageId");
  const msg = await LeadChatMessage.findOneAndDelete({ _id: messageId, authorId, kind: "message" });
  if (!msg) throw httpError(404, "Message not found or not yours");
  return { deleted: true };
};

// Scope-aware @mention candidates: active admins (the picker only needs name+id;
// the actual notification fires solely to whoever is chosen). Retained for any
// caller that wants the full roster of admins.
const mentionCandidates = async () => {
  const admins = await Admin.find({ status: "active" }, { name: 1 }).sort({ name: 1 }).lean();
  return admins.map((a) => ({ _id: a._id, name: a.name }));
};

// ── MB9a Slice 2 — PHASE-GATED chat membership ───────────────────────────────
// The lead chat's participants depend on the lifecycle window:
//   • PRE-QUAL  → the ASSIGNEE + the assignee's REPORTING MANAGER (only). If the
//     assignee has no manager, just the assignee.
//   • POST-QUAL → the MB8a roster (the huddle team).
// History is never touched — this only governs who participates / is mentionable
// / is notified going forward. Additive to MB7b (the legacy mentionCandidates
// remains for other callers).
const chatMembers = async (leadId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1, qualified: 1 }).lean();
  if (!lead) throw httpError(404, "Lead not found");

  let ids = [];
  if (lead.qualified) {
    const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
    const roster = await LeadTeamMemberRepository.findCurrentByLead(leadId);
    ids = roster.map((r) => String(r.personId));
  } else if (lead.assignedTo) {
    const assignee = await Admin.findById(lead.assignedTo, { name: 1, reportingManagerId: 1 }).lean();
    if (assignee) {
      ids = [String(assignee._id)];
      if (assignee.reportingManagerId) ids.push(String(assignee.reportingManagerId));
    }
  }
  ids = [...new Set(ids)];
  if (!ids.length) return [];
  const admins = await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean();
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));
  // Preserve the order ids were derived in (assignee first, then manager).
  return ids.map((id) => ({ _id: id, name: nameOf.get(id) || "—" })).filter((m) => m.name !== undefined);
};

module.exports = {
  listMessages,
  unreadCountForLead,
  postMessage,
  postSystemMessage,
  editMessage,
  deleteMessage,
  mentionCandidates,
  chatMembers,
};

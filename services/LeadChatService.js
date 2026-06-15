const mongoose = require("mongoose");
const LeadChatMessage = require("../models/LeadChatMessage");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const MAX_BODY = 5000;
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
  const filter = { leadId };
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
  LeadChatMessage.countDocuments({ leadId, authorId: { $ne: adminId }, readBy: { $ne: adminId } });

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
// the actual notification fires solely to whoever is chosen).
const mentionCandidates = async () => {
  const admins = await Admin.find({ status: "active" }, { name: 1 }).sort({ name: 1 }).lean();
  return admins.map((a) => ({ _id: a._id, name: a.name }));
};

module.exports = {
  listMessages,
  unreadCountForLead,
  postMessage,
  postSystemMessage,
  editMessage,
  deleteMessage,
  mentionCandidates,
};

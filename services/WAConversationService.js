const mongoose = require("mongoose");
const WAConversationRepository = require("../repositories/WAConversationRepository");
const WAAgentMessageRepository = require("../repositories/WAAgentMessageRepository");
const WAAgentMessage = require("../models/WAAgentMessage");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadIntakeService = require("./LeadIntakeService");
const LeadInternalEventService = require("./LeadInternalEventService");
const SettingsService = require("./SettingsService");
const { sendWhatsApp, sendWhatsAppText } = require("../utils/whatsapp");

// Meta's customer-service window: free-form messages are allowed only within
// 24 hours of the customer's last inbound message. Outside it, only approved
// templates go through.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PREVIEW_LEN = 120;

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const assertValidId = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, "Invalid conversation id");
  }
};

const preview = (text) => String(text || "").slice(0, PREVIEW_LEN);

// 24h-window helper: open while lastInboundAt is within 24h.
const windowInfo = (conversation, now = new Date()) => {
  const last = conversation && conversation.lastInboundAt
    ? new Date(conversation.lastInboundAt)
    : null;
  if (!last || Number.isNaN(last.getTime())) {
    return { windowOpen: false, windowClosesAt: null };
  }
  const closesAt = new Date(last.getTime() + WINDOW_MS);
  return { windowOpen: closesAt > now, windowClosesAt: closesAt };
};

// ── Hook 1 support: inbound touch + CRM lead linkage ─────────────────────────

// Upsert the conversation row for an inbound message (creates it on first
// contact) and bump freshness/unread.
const recordInbound = async (phone, text) => {
  const normalized = LeadIntakeService.normalizePhone(phone);
  return await WAConversationRepository.upsertOnInbound(phone, normalized, preview(text));
};

// Ensure the conversation is linked to a CRM lead — full intake semantics:
// normalized-phone dedup, re-enquiry on terminal leads, round-robin auto-assign.
// Idempotent: a linked conversation returns untouched.
const ensureLeadLinked = async (conversation, { profileName, firstMessage } = {}) => {
  if (!conversation) return conversation;
  if (conversation.enquiryId) return conversation;

  let enquiryId = null;
  const existing = await LeadIntakeService.findExistingByNormalizedPhone(conversation.phone);
  if (existing) {
    enquiryId = existing._id;
    // Dedup-merge: same person, new channel — re-enquiry semantics (badge,
    // resurfacing of recycled leads, Returned card for lost ones).
    await LeadIntakeService.recordReEnquiry(existing._id, {
      source: "whatsapp",
      message: firstMessage || "",
    });
  } else {
    const name = (profileName || "").trim() || `WhatsApp ${String(conversation.phone).slice(-4)}`;
    try {
      // Bug A fix (MB5 Slice 1): the shared intake create path — pins stage
      // and the create-path defaults so the lead is indistinguishable from a
      // manual create (round-robin auto-assign included).
      const created = await LeadIntakeService.createLead({
        name,
        phone: conversation.phone,
        verified: false,
        source: "whatsapp",
        additionalInfo: {},
      });
      enquiryId = created._id;
    } catch (e) {
      // Unique-phone race (duplicate webhook delivery): fall back to the winner.
      const winner = await LeadIntakeService.findExistingByNormalizedPhone(conversation.phone);
      if (!winner) throw e;
      enquiryId = winner._id;
    }
  }

  const updated = await WAConversationRepository.updateFieldsById(conversation._id, {
    enquiryId,
  });
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "wa_conversation_started",
    actorId: null,
    payload: { phone: conversation.phone, firstMessage: preview(firstMessage) },
  });
  return updated;
};

// ── Admin chat API (Slice 4) ──────────────────────────────────────────────────

// Conversations visible to the caller: scoped through the LINKED LEAD using the
// same scope filter the lead routes build (ownerField assignedTo). Conversations
// without a lead link surface only for all-scope callers.
const listInbox = async ({ mode, needsHuman, status, enquiryId, page = 1, limit = 20 } = {}, scopeFilter = {}) => {
  const filter = {};
  if (mode === "ai" || mode === "human") filter.mode = mode;
  if (needsHuman === "true" || needsHuman === true) filter.needsHuman = true;
  if (status === "active" || status === "closed") filter.status = status;
  if (enquiryId && mongoose.Types.ObjectId.isValid(enquiryId)) filter.enquiryId = enquiryId;

  const unscoped = Object.keys(scopeFilter).length === 0;
  if (!unscoped) {
    const inScope = await Enquiry.find(scopeFilter, { _id: 1 }).lean();
    filter.enquiryId = { $in: inScope.map((l) => l._id) };
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const [rows, total] = await Promise.all([
    WAConversationRepository.list(filter, { skip: (pageNum - 1) * lim, limit: lim }),
    WAConversationRepository.count(filter),
  ]);

  // Join the lead summary (name, stage, owner) in two queries.
  const leadIds = rows.map((r) => r.enquiryId).filter(Boolean);
  const leads = leadIds.length
    ? await Enquiry.find(
        { _id: { $in: leadIds } },
        { name: 1, stage: 1, assignedTo: 1, qualified: 1 }
      ).lean()
    : [];
  const ownerIds = [...new Set(leads.map((l) => l.assignedTo).filter(Boolean).map(String))];
  const owners = ownerIds.length
    ? await Admin.find({ _id: { $in: ownerIds } }, { name: 1 }).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o.name]));

  const now = new Date();
  const list = rows.map((c) => {
    const lead = c.enquiryId ? leadById.get(String(c.enquiryId)) : null;
    return {
      ...c,
      ...windowInfo(c, now),
      lead: lead
        ? {
            _id: lead._id,
            name: lead.name,
            stage: lead.stage,
            qualified: !!lead.qualified,
            ownerId: lead.assignedTo || null,
            ownerName: lead.assignedTo ? ownerById.get(String(lead.assignedTo)) || null : null,
          }
        : null,
    };
  });

  return { list, total, page: pageNum, totalPages: Math.max(1, Math.ceil(total / lim)) };
};

// Load + scope-check one conversation (404 unknown, 403 out of scope).
const getScoped = async (conversationId, scopeFilter = {}) => {
  assertValidId(conversationId);
  const conversation = await WAConversationRepository.findById(conversationId);
  if (!conversation) throw httpError(404, "Conversation not found");
  const unscoped = Object.keys(scopeFilter).length === 0;
  if (!unscoped) {
    if (!conversation.enquiryId) throw httpError(403, "Out of your scope");
    const lead = await Enquiry.findOne({
      $and: [{ _id: conversation.enquiryId }, scopeFilter],
    }).lean();
    if (!lead) throw httpError(403, "Out of your scope");
  }
  return conversation;
};

// Paginated thread, newest page first by createdAt asc within the page. Marks read.
const getMessages = async (conversationId, { page = 1, limit = 50 } = {}, scopeFilter = {}) => {
  const conversation = await getScoped(conversationId, scopeFilter);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [total, docs] = await Promise.all([
    WAAgentMessage.countDocuments({ phone: conversation.phone }),
    WAAgentMessage.find({ phone: conversation.phone })
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * lim)
      .limit(lim)
      .populate("sentBy", "name")
      .lean(),
  ]);
  if (conversation.unreadCount > 0) {
    await WAConversationRepository.updateFieldsById(conversation._id, { unreadCount: 0 });
  }
  // Whether the re-engage template is configured (the UI disables its send
  // button with an explanatory tooltip when it isn't).
  let reengageTemplateSet = false;
  try {
    reengageTemplateSet = !!(await SettingsService.get("kiara.reengageTemplateName"));
  } catch (_) { /* settings read is advisory here */ }
  return {
    conversation: {
      ...conversation.toObject(),
      ...windowInfo(conversation),
      unreadCount: 0,
      reengageTemplateSet,
    },
    messages: docs.reverse(),
    total,
    page: pageNum,
    totalPages: Math.max(1, Math.ceil(total / lim)),
  };
};

// Sticky human takeover: Kiara stops replying until an explicit hand-back.
const takeover = async (conversationId, actorId, scopeFilter = {}) => {
  const conversation = await getScoped(conversationId, scopeFilter);
  const updated = await WAConversationRepository.updateFieldsById(conversation._id, {
    mode: "human",
    needsHuman: false,
    needsHumanReason: "",
    needsHumanAt: null,
  });
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: "wa_human_takeover",
      actorId,
      payload: {},
    });
  }
  return { ...updated.toObject(), ...windowInfo(updated) };
};

const handback = async (conversationId, actorId, scopeFilter = {}) => {
  const conversation = await getScoped(conversationId, scopeFilter);
  const updated = await WAConversationRepository.updateFieldsById(conversation._id, {
    mode: "ai",
    needsHuman: false,
    needsHumanReason: "",
    needsHumanAt: null,
  });
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: "wa_handed_back",
      actorId,
      payload: {},
    });
  }
  return { ...updated.toObject(), ...windowInfo(updated) };
};

// Free-form send: human mode only (409 tells the UI to take over first) and
// only inside the 24h window (422 {windowClosed:true} → re-engage template).
const sendText = async (conversationId, text, actorId, scopeFilter = {}) => {
  if (typeof text !== "string" || !text.trim()) throw httpError(400, "text is required");
  if (text.length > 4096) throw httpError(400, "Message is too long (max 4096 chars)");
  const conversation = await getScoped(conversationId, scopeFilter);
  if (conversation.mode !== "human") {
    throw httpError(409, "Kiara is handling this conversation — take over before sending");
  }
  const { windowOpen, windowClosesAt } = windowInfo(conversation);
  if (!windowOpen) {
    throw httpError(
      422,
      "The 24-hour WhatsApp window has closed — use the re-engage template",
      { windowClosed: true, windowClosesAt }
    );
  }
  const clean = text.trim();
  const sent = await sendWhatsAppText(
    conversation.phone,
    clean,
    process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID
  );
  if (!sent) throw httpError(502, "WhatsApp send failed — try again");

  const saved = await new WAAgentMessage({
    phone: conversation.phone,
    role: "assistant",
    message: clean,
    sentBy: actorId || null,
  }).save();
  const updated = await WAConversationRepository.touchOutbound(conversation._id, preview(clean));
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: "wa_admin_message_sent",
      actorId,
      payload: { preview: preview(clean) },
    });
  }
  return { message: saved, conversation: { ...updated.toObject(), ...windowInfo(updated) } };
};

// Template send (re-engage): allowed with the window closed, still human-mode-only.
const sendTemplate = async (conversationId, actorId, scopeFilter = {}) => {
  const conversation = await getScoped(conversationId, scopeFilter);
  if (conversation.mode !== "human") {
    throw httpError(409, "Kiara is handling this conversation — take over before sending");
  }
  const templateName = await SettingsService.get("kiara.reengageTemplateName");
  if (!templateName) {
    throw httpError(422, "No re-engage template configured — set kiara.reengageTemplateName in Settings");
  }
  let name = "";
  if (conversation.enquiryId) {
    const lead = await Enquiry.findById(conversation.enquiryId, { name: 1 }).lean();
    name = lead ? (lead.name || "").split(/\s+/)[0] : "";
  }
  const sent = await sendWhatsApp(
    conversation.phone,
    templateName,
    [name || "there"],
    null,
    process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID
  );
  if (!sent) throw httpError(502, "WhatsApp template send failed — try again");

  const body = `[template: ${templateName}]`;
  const saved = await new WAAgentMessage({
    phone: conversation.phone,
    role: "assistant",
    message: body,
    sentBy: actorId || null,
  }).save();
  const updated = await WAConversationRepository.touchOutbound(conversation._id, body);
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: "wa_template_sent",
      actorId,
      payload: { template: templateName },
    });
  }
  return { message: saved, conversation: { ...updated.toObject(), ...windowInfo(updated) } };
};

module.exports = {
  WINDOW_MS,
  windowInfo,
  recordInbound,
  ensureLeadLinked,
  listInbox,
  getScoped,
  getMessages,
  takeover,
  handback,
  sendText,
  sendTemplate,
};

const mongoose = require("mongoose");
const WAConversationRepository = require("../repositories/WAConversationRepository");
const WAAgentMessageRepository = require("../repositories/WAAgentMessageRepository");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const WAAgentMessage = require("../models/WAAgentMessage");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadIntakeService = require("./LeadIntakeService");
const AdminNotificationService = require("./AdminNotificationService");
const LeadInternalEventService = require("./LeadInternalEventService");
const SettingsService = require("./SettingsService");
const { sendWhatsApp, sendWhatsAppText } = require("../utils/whatsapp");

// Meta's customer-service window: free-form messages are allowed only within
// 24 hours of the customer's last inbound message. Outside it, only approved
// templates go through.
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta's HUMAN AGENT tag permits a HUMAN reply for 7 days after the customer's
// last message — Instagram only. Same clock as WINDOW_MS (lastInboundAt), a
// different constant. See humanAgentInfo below.
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── WHY INSTAGRAM IS TREATED MORE URGENTLY THAN WHATSAPP ───────────────────
// Do not "harmonise" these. The consequences are not the same shape.
//
// On WhatsApp a closed window is an INCONVENIENCE: the re-engage template
// exists, costs a little, and works months later. The lead is still reachable.
//
// On Instagram there is no equivalent. Past 7 days from the customer's last
// message there is NO mechanism to reach that person again — the thread is
// permanently unreachable and the lead is gone. The deadline is real,
// irreversible, and invisible unless something says so.
//
// The audience is a salesperson glancing at an inbox, not someone studying a
// chip. So Instagram gets escalating urgency levels and generous thresholds
// (a day is "critical", two days "warning"), while WhatsApp keeps a quiet
// indicator. Anyone flattening these into one scale is reintroducing a silent
// permanent data loss.
const IG_CRITICAL_MS = 24 * 60 * 60 * 1000;      // < 1 day left
const IG_WARNING_MS = 48 * 60 * 60 * 1000;       // < 2 days left
const PREVIEW_LEN = 120;

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const assertValidId = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, "Invalid conversation id");
  }
};

const preview = (text) => String(text || "").slice(0, PREVIEW_LEN);

// The 7-day human-agent window. Instagram only — on WhatsApp the concept does
// not exist and every field comes back null/false, so callers can read this
// unconditionally without branching on channel.
//
// SAME CLOCK AS windowInfo: lastInboundAt, the customer's last message. Not
// thread creation, not last activity — an outbound staff message must NOT
// extend the deadline, because Meta's clock does not move either. Regressing
// this to lastMessageAt would show a countdown that lies.
const humanAgentInfo = (conversation, now = new Date()) => {
  const isIg = conversation && conversation.channel === "instagram";
  const last = conversation && conversation.lastInboundAt
    ? new Date(conversation.lastInboundAt)
    : null;
  if (!isIg || !last || Number.isNaN(last.getTime())) {
    return {
      humanAgentWindowOpen: false,
      humanAgentWindowClosesAt: null,
      humanAgentMsRemaining: null,
    };
  }
  const closesAt = new Date(last.getTime() + HUMAN_AGENT_WINDOW_MS);
  const msRemaining = closesAt.getTime() - now.getTime();
  return {
    humanAgentWindowOpen: msRemaining > 0,
    humanAgentWindowClosesAt: closesAt,
    humanAgentMsRemaining: msRemaining > 0 ? msRemaining : 0,
  };
};

// 24h-window helper: open while lastInboundAt is within 24h.
//
// ALSO carries `sendWindow` — everything the inbox needs to render a countdown,
// computed here so every payload that already spreads windowInfo() gets it for
// free (list, get, takeover, handback, sendText, sendTemplate). API side only;
// the frontend decides how loud to be, and `urgency` tells it how loud to be.
const windowInfo = (conversation, now = new Date()) => {
  const last = conversation && conversation.lastInboundAt
    ? new Date(conversation.lastInboundAt)
    : null;
  const isIg = conversation && conversation.channel === "instagram";
  const ha = humanAgentInfo(conversation, now);

  if (!last || Number.isNaN(last.getTime())) {
    return {
      windowOpen: false,
      windowClosesAt: null,
      ...ha,
      sendWindow: {
        channel: isIg ? "instagram" : "whatsapp",
        kind: null,
        canSendNow: false,
        closesAt: null,
        msRemaining: null,
        urgency: "unknown",
      },
    };
  }

  const closesAt = new Date(last.getTime() + WINDOW_MS);
  const windowOpen = closesAt > now;

  // Which deadline actually governs the next human send, and how urgent is it?
  //   WhatsApp  — the 24h window; past it there is a re-engage template.
  //   Instagram — the 24h window while open, then the 7-day human-agent window.
  //               Past THAT the person is unreachable forever.
  let sendWindow;
  if (!isIg) {
    sendWindow = {
      channel: "whatsapp",
      kind: "24h",
      canSendNow: windowOpen,
      closesAt,
      msRemaining: Math.max(0, closesAt.getTime() - now.getTime()),
      // Deliberately flat: a closed WhatsApp window is recoverable with a
      // template, so it is a state to show, not an alarm to raise.
      urgency: windowOpen ? "open" : "template_required",
    };
  } else {
    const msRemaining = ha.humanAgentMsRemaining;
    let urgency;
    if (!ha.humanAgentWindowOpen) urgency = "expired";
    else if (msRemaining < IG_CRITICAL_MS) urgency = "critical";
    else if (msRemaining < IG_WARNING_MS) urgency = "warning";
    else urgency = "open";
    sendWindow = {
      channel: "instagram",
      // Inside 24h an ordinary DM is enough; past it the send carries the
      // HUMAN_AGENT tag. Either way the DEADLINE the inbox counts down to is
      // the 7-day one, because that is when the lead is lost for good.
      kind: windowOpen ? "24h" : "human_agent",
      canSendNow: ha.humanAgentWindowOpen,
      closesAt: ha.humanAgentWindowClosesAt,
      msRemaining,
      urgency,
    };
  }

  return { windowOpen, windowClosesAt: closesAt, ...ha, sendWindow };
};

// ── Inbound → owner bell notification (additive) ──────────────────────────────
// Fires ONLY for genuine customer messages. That guard is STRUCTURAL, not a
// field check: recordInbound() below is reached solely from the four inbound
// webhook paths (WhatsApp text + media, Instagram text + attachment), each of
// which persists role:'user'. Staff sends (sendText/sendTemplate) and Kiara's
// own replies both route through WAConversationRepository.touchOutbound and
// never come through here — so admin and agent traffic cannot reach this.
//
// Skips silently when the conversation has no linked lead yet, or the lead is
// unassigned: the new_lead / triage_assigned notifications already own that
// moment, and we never broadcast to the team.
//
// Fire-safe (the Instagram-agent pattern): try/catch + console.error, so a
// notification failure never breaks message delivery.
const CHAT_PREVIEW_LEN = 60;

const notifyOwnerOfInbound = async (conversation, text) => {
  try {
    if (!conversation || !conversation.enquiryId) return;
    const lead = await Enquiry.findById(conversation.enquiryId, { name: 1, assignedTo: 1 }).lean();
    if (!lead || !lead.assignedTo) return; // unassigned → no notification, no broadcast
    const from = conversation.profileName || conversation.phone || "";
    const snippet = String(text || "").slice(0, CHAT_PREVIEW_LEN);
    await AdminNotificationService.notifyOnce(lead.assignedTo, {
      type: "chat",
      title: `New message from ${from || lead.name || "a lead"}`,
      message: snippet,
      leadId: lead._id,
      payload: {
        leadId: String(lead._id),
        chatId: String(conversation._id),
        preview: snippet,
        from,
      },
    });
  } catch (e) {
    console.error("[WAConversation] inbound owner notification failed:", e.message);
  }
};

// ── Hook 1 support: inbound touch + CRM lead linkage ─────────────────────────

// Upsert the conversation row for an inbound message (creates it on first
// contact) and bump freshness/unread. channel: 'whatsapp' (phone-keyed) or
// 'instagram' (IG-user-id-keyed — no meaningful normalized phone).
const recordInbound = async (phone, text, channel = "whatsapp") => {
  const normalized = channel === "whatsapp" ? LeadIntakeService.normalizePhone(phone) : "";
  const conversation = await WAConversationRepository.upsertOnInbound(phone, normalized, preview(text), new Date(), channel);
  // Additive: ping the lead's owner in the OS bell. Deliberately AFTER the
  // upsert and awaited-but-swallowed, so the conversation write is already
  // durable and a notification failure cannot change what this returns.
  await notifyOwnerOfInbound(conversation, text);
  return conversation;
};

// Journey event types are channel-prefixed (wa_* / ig_*).
const evType = (conversation, suffix) =>
  `${conversation && conversation.channel === "instagram" ? "ig" : "wa"}_${suffix}`;

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

  const requestedEnquiryId =
    enquiryId && mongoose.Types.ObjectId.isValid(enquiryId) ? enquiryId : null;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  // Resolve the enquiryId filter as an INTERSECTION of (a) the specific lead the
  // caller asked for and (b) the caller's scope. Never let one bypass the other:
  // a scoped admin must not see an out-of-scope conversation just by passing its
  // enquiryId, and a requested enquiryId must not be widened back to "all in scope".
  const unscoped = Object.keys(scopeFilter).length === 0;
  if (unscoped) {
    // Super-admin: honour the requested lead if any, otherwise no enquiry filter.
    if (requestedEnquiryId) filter.enquiryId = requestedEnquiryId;
  } else {
    const inScope = await Enquiry.find(scopeFilter, { _id: 1 }).lean();
    const inScopeIds = inScope.map((l) => l._id);
    if (requestedEnquiryId) {
      // Enforce scope: the requested lead must be one of the caller's in-scope
      // ids, else return empty — do NOT leak an out-of-scope conversation.
      const inScopeStr = new Set(inScopeIds.map(String));
      if (!inScopeStr.has(String(requestedEnquiryId))) {
        return { list: [], total: 0, page: pageNum, totalPages: 1 };
      }
      filter.enquiryId = requestedEnquiryId;
    } else {
      filter.enquiryId = { $in: inScopeIds };
    }
  }
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
      type: evType(conversation, "human_takeover"),
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
      type: evType(conversation, "handed_back"),
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
  const isInstagram = conversation.channel === "instagram";
  const { windowOpen, windowClosesAt } = windowInfo(conversation);
  const { humanAgentWindowOpen, humanAgentWindowClosesAt } = humanAgentInfo(conversation);

  // WHOSE WINDOW CLOSED, AND WHAT THAT MEANS.
  //
  // WhatsApp: unchanged. A closed 24-hour window is a 422 { windowClosed } and
  // the caller sends a re-engage template. That is the CORRECT behaviour there
  // and this branch must keep it exactly.
  //
  // Instagram: the 24-hour window closing is NOT the end. Meta's HUMAN_AGENT
  // tag lets a person reply for 7 days from the customer's last message, which
  // is the whole point of this path — without it a human physically cannot
  // answer a thread that went quiet overnight.
  if (!windowOpen) {
    if (!isInstagram) {
      throw httpError(
        422,
        "The 24-hour WhatsApp window has closed — use the re-engage template",
        { windowClosed: true, windowClosesAt }
      );
    }
    if (!humanAgentWindowOpen) {
      // THE 7-DAY CAP. Refused here, deliberately and specifically, rather than
      // sent and left for Meta to reject. A named deadline a person can act on
      // beats a generic 422 they cannot, and refusing on our side keeps us
      // provably inside policy instead of relying on Meta to enforce it.
      //
      // Distinct flag from windowClosed on purpose: this is not "use a
      // template", because on Instagram there is no template and no other way
      // back. The conversation is over.
      throw httpError(
        422,
        "This Instagram conversation can no longer be replied to. Meta allows a human reply for 7 days after the customer's last message, and that period ended on " +
          (humanAgentWindowClosesAt ? humanAgentWindowClosesAt.toISOString().slice(0, 10) : "an earlier date") +
          ". Reach out on another channel if you have one.",
        {
          humanAgentWindowClosed: true,
          humanAgentWindowClosesAt,
          windowClosesAt,
        }
      );
    }
  }

  const clean = text.trim();
  // MB6 Slice 7: channel-aware delivery — IG threads send a DM, not WhatsApp.
  let sent;
  if (isInstagram) {
    // Inside 24h an ordinary DM is correct and sufficient. Past it, the send
    // needs the HUMAN_AGENT tag. The tag is NOT applied unconditionally: it is
    // a claim that a person is replying outside the standard window, and making
    // that claim when it is not needed overstates our use of the permission.
    //
    // Either branch is a human send — the mode !== "human" check above already
    // threw 409 — so the claim is true wherever it is made.
    const { sendInstagramDM, sendInstagramHumanAgentDM } = require("../utils/instagram");
    sent = windowOpen
      ? await sendInstagramDM(conversation.phone, clean)
      : await sendInstagramHumanAgentDM(conversation.phone, clean);
  } else {
    sent = await sendWhatsAppText(conversation.phone, clean, process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID);
  }
  if (!sent) throw httpError(502, `${conversation.channel === "instagram" ? "Instagram" : "WhatsApp"} send failed — try again`);

  const saved = await new WAAgentMessage({
    phone: conversation.phone,
    role: "assistant",
    message: clean,
    sentBy: actorId || null,
  }).save();
  // Bug B fix (MB5 Slice 1): the response message must have the SAME shape as
  // getMessages (sentBy populated to {_id,name}) — the chat panel appends it
  // optimistically and renders sentBy.name.
  await saved.populate("sentBy", "name");
  const updated = await WAConversationRepository.touchOutbound(conversation._id, preview(clean));
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: evType(conversation, "admin_message_sent"),
      actorId,
      payload: { preview: preview(clean) },
    });
    // Signal spine: an outbound WA/IG message is an any-channel customer
    // response and employee activity (firstCalledAt stays call-only).
    await EnquiryRepository.stampFirstRespondedAt(conversation.enquiryId);
    await EnquiryRepository.touchLastActivity(conversation.enquiryId);
  }
  return { message: saved, conversation: { ...updated.toObject(), ...windowInfo(updated) } };
};

// Template send (re-engage): allowed with the window closed, still human-mode-only.
const sendTemplate = async (conversationId, actorId, scopeFilter = {}) => {
  const conversation = await getScoped(conversationId, scopeFilter);
  if (conversation.channel === "instagram") {
    throw httpError(422, "Templates are a WhatsApp feature — Instagram chats can't be re-engaged this way");
  }
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
  // Bug B fix: same shape as getMessages (sentBy populated) — see sendText.
  await saved.populate("sentBy", "name");
  const updated = await WAConversationRepository.touchOutbound(conversation._id, body);
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: "wa_template_sent",
      actorId,
      payload: { template: templateName },
    });
    // Signal spine: a re-engage template is an outbound customer touch too.
    await EnquiryRepository.stampFirstRespondedAt(conversation.enquiryId);
    await EnquiryRepository.touchLastActivity(conversation.enquiryId);
  }
  return { message: saved, conversation: { ...updated.toObject(), ...windowInfo(updated) } };
};

module.exports = {
  WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
  windowInfo,
  humanAgentInfo,
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

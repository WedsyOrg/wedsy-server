const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Project = require("../models/Project");
const LeadTask = require("../models/LeadTask");
const NurtureTemplate = require("../models/NurtureTemplate");
const SettingsService = require("./SettingsService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const LeadTaskService = require("./LeadTaskService");
const { callAnthropic } = require("../utils/anthropicQueue");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY_MS = 24 * 60 * 60 * 1000;

const cadenceDays = async () => {
  try {
    return await SettingsService.get("nurture.cadenceDays");
  } catch (_) {
    return 2;
  }
};

// The CS person who owns the relationship: the Project's csOwnerId, else the
// lead's current assignee.
const csOwnerFor = async (lead) => {
  const project = await Project.findOne({ leadId: lead._id }, { csOwnerId: 1 }).lean();
  if (project && project.csOwnerId) return project.csOwnerId;
  return lead.assignedTo || null;
};

const SYSTEM_PROMPT =
  "You are Kiara, drafting a warm, personal WhatsApp message for a Wedsy customer-success " +
  "rep to paste into the couple's wedding planning group. One short paragraph, friendly and " +
  "specific to the couple, no markdown, no preamble — just the message text the rep will send.";

const firstTextBlock = (response) => {
  const content = response && response.data && Array.isArray(response.data.content) ? response.data.content : [];
  const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text.trim() : null;
};

// Draft ready-to-copy text. Haiku-personalized from lead data; on any failure
// falls back to a Library entry, then a generic line — nurture must never block
// on the model.
const draftText = async (lead) => {
  const q = lead.qualificationData || {};
  const couple = [q.groomName, q.brideName].filter(Boolean).join(" & ") || lead.name || "there";
  try {
    const facts = [
      `Couple: ${couple}`,
      q.weddingStyle ? `Style: ${q.weddingStyle}` : "",
      (q.servicesRequired || []).length ? `Services: ${(q.servicesRequired || []).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const response = await callAnthropic({
      model: "claude-haiku-4-5",
      max_tokens: 160,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Lead facts:\n${facts}\n\nWrite the nurture message.` }],
    });
    const text = firstTextBlock(response);
    if (text) return text;
  } catch (e) {
    console.error("[Nurture] draftText AI failed, using library/fallback:", e.message);
  }
  // Library fallback: the most recently added template, if any.
  try {
    const tmpl = await NurtureTemplate.findOne({}).sort({ createdAt: -1 }).lean();
    if (tmpl && tmpl.text) return tmpl.text;
  } catch (_) { /* ignore */ }
  return `Hi ${couple}! Just checking in from the Wedsy team — how are the wedding plans coming along? Anything we can help move forward this week?`;
};

// Create the rolling nurture task if nurture is active and none is open.
const scheduleNurtureTask = async (leadId) => {
  if (!isId(leadId)) return null;
  const lead = await Enquiry.findById(leadId);
  if (!lead || !lead.nurture || !lead.nurture.active || !lead.whatsappGroupCreated) return null;

  const open = await LeadTask.findOne({ leadId, kind: "nurture", status: "open" }).lean();
  if (open) return open;

  const assigneeId = await csOwnerFor(lead);
  if (!assigneeId) return null;
  const days = await cadenceDays();
  const text = await draftText(lead);
  return await LeadTaskService.createTask(
    leadId,
    {
      title: "Nurture touch — message the couple's WhatsApp group",
      assigneeId,
      dueAt: new Date(Date.now() + days * DAY_MS),
      kind: "nurture",
      nurtureText: text,
    },
    assigneeId
  );
};

// G-Meet close gate — "Yes, the WhatsApp group exists": switch nurture on,
// clear any red flag, start the cadence clock + first task.
const markGroupCreated = async (leadId, actorId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const now = new Date();
  await Enquiry.findByIdAndUpdate(leadId, {
    $set: {
      whatsappGroupCreated: true,
      whatsappGroupCreatedAt: now,
      "whatsappGroupFlag.raised": false,
      "whatsappGroupFlag.clearedAt": now,
      "nurture.active": true,
      "nurture.lastTouchAt": now,
    },
  });
  await LeadInternalEventService.record({
    leadId,
    type: "wa_group_created",
    actorId: actorId || null,
    payload: {},
  });
  await scheduleNurtureTask(leadId);
  return { whatsappGroupCreated: true };
};

// G-Meet close gate — "No": raise the red flag (file + dashboard) and notify the
// owner + CS Manager + Revenue Manager. nurture stays off.
const raiseGroupFlag = async (leadId, actorId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const lead = await Enquiry.findByIdAndUpdate(
    leadId,
    { $set: { "whatsappGroupFlag.raised": true, "whatsappGroupFlag.raisedAt": new Date() } },
    { new: true }
  ).lean();
  if (!lead) throw httpError(404, "Lead not found");

  const recipients = new Set();
  if (lead.assignedTo) recipients.add(String(lead.assignedTo));
  const [csm, rvm] = await Promise.all([
    LeadTaskService.idsByRoleName("CS Manager"),
    LeadTaskService.idsByRoleName("Revenue Manager"),
  ]);
  [...csm, ...rvm].forEach((id) => recipients.add(String(id)));
  await AdminNotificationService.notify([...recipients].filter(Boolean), {
    type: "wa_group_missing",
    title: `No WhatsApp group yet for ${lead.name}`,
    message: "Meet closed without confirming the couple's group — nurture is blocked until it's created.",
    leadId,
  });
  await LeadInternalEventService.record({
    leadId,
    type: "wa_group_missing",
    actorId: actorId || null,
    payload: {},
  });
  return { whatsappGroupFlag: true };
};

// The G-Meet close hook: route the Yes/No answer. Tolerant by design (a missing
// answer is a no-op) so the MB5+6 meeting-close path stays backward compatible;
// the mandatory Yes/No lives in the close UI.
const applyGroupAnswer = async (leadId, answer, actorId) => {
  if (answer === true) return markGroupCreated(leadId, actorId);
  if (answer === false) return raiseGroupFlag(leadId, actorId);
  return null;
};

// A completed nurture touch → nurture_touch journey + reset the cadence clock +
// schedule the next task.
const completeTouch = async (taskId, actorId) => {
  const task = await LeadTaskService.completeTask(taskId, actorId);
  if (task.kind !== "nurture") return task;
  const now = new Date();
  await Enquiry.findByIdAndUpdate(task.leadId, { $set: { "nurture.lastTouchAt": now } });
  await LeadInternalEventService.record({
    leadId: task.leadId,
    type: "nurture_touch",
    actorId: actorId || null,
    payload: { taskId: String(task._id) },
  });
  await scheduleNurtureTask(task.leadId);
  return task;
};

// Couple inbound counts as a touch: reset the clock and push the open nurture
// task forward — don't nag an active group. Fire-safe (hooked from the WA path).
const registerInboundTouch = async (leadId) => {
  try {
    if (!isId(leadId)) return null;
    const lead = await Enquiry.findById(leadId, { nurture: 1, whatsappGroupCreated: 1 }).lean();
    if (!lead || !lead.nurture || !lead.nurture.active) return null;
    const now = new Date();
    await Enquiry.findByIdAndUpdate(leadId, { $set: { "nurture.lastTouchAt": now } });
    const days = await cadenceDays();
    await LeadTask.updateMany(
      { leadId, kind: "nurture", status: "open" },
      { $set: { dueAt: new Date(now.getTime() + days * DAY_MS), overdueEscalatedAt: null } }
    );
    await LeadInternalEventService.record({
      leadId,
      type: "nurture_touch",
      actorId: null,
      payload: { source: "couple_inbound" },
    });
    return true;
  } catch (e) {
    console.error("[Nurture] registerInboundTouch failed:", e.message);
    return null;
  }
};

// ── Nurture Library CRUD (founder-editable) ────────────────────────────────────
const listTemplates = async () => NurtureTemplate.find({}).sort({ category: 1, createdAt: -1 }).lean();

const createTemplate = async ({ category, title, text, link } = {}, createdBy) => {
  const c = String(category || "").trim();
  const t = String(title || "").trim();
  const body = String(text || "").trim();
  if (!c || !t || !body) throw httpError(400, "category, title and text are required");
  return NurtureTemplate.create({
    category: c.slice(0, 120),
    title: t.slice(0, 200),
    text: body.slice(0, 5000),
    link: String(link || "").slice(0, 500),
    createdBy: createdBy || null,
  });
};

const updateTemplate = async (id, { category, title, text, link } = {}) => {
  if (!isId(id)) throw httpError(400, "Invalid template id");
  const set = {};
  if (category !== undefined) set.category = String(category).trim().slice(0, 120);
  if (title !== undefined) set.title = String(title).trim().slice(0, 200);
  if (text !== undefined) set.text = String(text).trim().slice(0, 5000);
  if (link !== undefined) set.link = String(link).slice(0, 500);
  if (!Object.keys(set).length) throw httpError(400, "Nothing to update");
  const updated = await NurtureTemplate.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
  if (!updated) throw httpError(404, "Template not found");
  return updated;
};

const deleteTemplate = async (id) => {
  if (!isId(id)) throw httpError(400, "Invalid template id");
  const deleted = await NurtureTemplate.findByIdAndDelete(id).lean();
  if (!deleted) throw httpError(404, "Template not found");
  return { deleted: true };
};

module.exports = {
  cadenceDays,
  draftText,
  scheduleNurtureTask,
  markGroupCreated,
  raiseGroupFlag,
  applyGroupAnswer,
  completeTouch,
  registerInboundTouch,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};

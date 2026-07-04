const Enquiry = require("../models/Enquiry");
const WAConversation = require("../models/WAConversation");
const WAAgentMessage = require("../models/WAAgentMessage");
const SettingsService = require("./SettingsService");
const LeadIntakeService = require("./LeadIntakeService");
const LeadInternalEventService = require("./LeadInternalEventService");
const { sendWhatsApp } = require("../utils/whatsapp");
const { toIstWallClock, goldenWindowFor } = require("../utils/goldenWindow");

// KIARA SAFETY NET (MB5 Slice 5) — template-gated, ships DORMANT.
// When kiara.welcomeTemplateName is set:
//  (a) a lead created OUTSIDE working hours with a phone gets the welcome
//      template from Kiara's number immediately + an open ai-mode conversation
//  (b) a lead created IN hours but still uncontacted (no firstCalledAt) past
//      the golden window gets the same engagement — once per lead.
// Engaged leads join mission-quiet until escalation/qualification; after-hours
// leads surface in triage at open with the Kiara transcript attached.

// Meta wa_id format: digits with country code (Indian default).
const metaPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const templateName = async () => {
  try {
    return (await SettingsService.get("kiara.welcomeTemplateName")) || "";
  } catch (_) {
    return "";
  }
};

const inWorkingHours = async (now = new Date()) => {
  const cfg = await SettingsService.getMany(["golden.workStartHour", "golden.workEndHour"]);
  const istHour = toIstWallClock(now).getUTCHours();
  return istHour >= cfg["golden.workStartHour"] && istHour < cfg["golden.workEndHour"];
};

// The engagement itself: template out, conversation open (mode ai), thread
// placeholder stored, set-once marker + journey event. CAS-guarded.
const engageLead = async (lead, reason, now = new Date()) => {
  const tpl = await templateName();
  if (!tpl) return false; // dormant
  const phone = metaPhone(lead.phone);
  if (!phone || phone.length < 12) return false;

  // Once per lead — atomic claim.
  const claimed = await Enquiry.findOneAndUpdate(
    { _id: lead._id, kiaraSafetyNetAt: null },
    { $set: { kiaraSafetyNetAt: now } },
    { new: true }
  );
  if (!claimed) return false;

  const firstName = (lead.name || "").split(/\s+/)[0] || "there";
  const sent = await sendWhatsApp(phone, tpl, [firstName], null, process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID);
  if (!sent) {
    // Roll the claim back so a transient Meta failure can retry on a later sweep.
    await Enquiry.findByIdAndUpdate(lead._id, { $set: { kiaraSafetyNetAt: null } });
    return false;
  }

  const body = `[template: ${tpl}]`;
  await WAConversation.findOneAndUpdate(
    { phone },
    {
      $setOnInsert: {
        phone,
        normalizedPhone: LeadIntakeService.normalizePhone(phone),
        mode: "ai",
        status: "active",
        unreadCount: 0,
      },
      $set: {
        enquiryId: lead._id,
        lastMessageAt: now,
        lastMessagePreview: body,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await new WAAgentMessage({ phone, role: "assistant", message: body, sentBy: null }).save();
  await LeadInternalEventService.record({
    leadId: lead._id,
    type: "kiara_safety_net_engaged",
    actorId: null,
    payload: { reason, template: tpl },
  });
  return true;
};

// (a) Create-time hook — fires only OUTSIDE working hours. Fire-safe; called
// from LeadIntakeService.afterCreate for every intake path.
const maybeEngageOnCreate = async (enquiryId, now = new Date()) => {
  try {
    if (!(await templateName())) return false; // dormant — zero queries beyond settings cache
    if (await inWorkingHours(now)) return false;
    const lead = await Enquiry.findById(enquiryId).lean();
    if (!lead || !lead.phone) return false;
    if (lead.source === "whatsapp") return false; // already talking to Kiara
    if (lead.kiaraSafetyNetAt) return false;
    return await engageLead(lead, "after_hours_create", now);
  } catch (e) {
    console.error("KiaraSafetyNet.maybeEngageOnCreate failed:", e.message);
    return false;
  }
};

// (b) Lazy sweep (rides dashboard reads): in-hours leads past the golden
// window with no first call. Bounded to the last 48h of creates.
const sweepGoldenWindowMisses = async (now = new Date()) => {
  try {
    if (!(await templateName())) return { engaged: 0 }; // dormant
    if (!(await inWorkingHours(now))) return { engaged: 0 };
    const cfg = await SettingsService.getMany([
      "golden.windowMinutes",
      "golden.workStartHour",
      "golden.workEndHour",
    ]);
    const goldenCfg = {
      windowMinutes: cfg["golden.windowMinutes"],
      workStartHour: cfg["golden.workStartHour"],
      workEndHour: cfg["golden.workEndHour"],
    };
    const candidates = await Enquiry.find({
      kiaraSafetyNetAt: null,
      firstCalledAt: null,
      source: { $ne: "whatsapp" },
      phone: { $nin: [null, ""] },
      importedAt: null, // historical imports never get pinged
      stage: { $nin: ["won", "lost"] },
      "recycled.isRecycled": { $ne: true },
      createdAt: { $gte: new Date(now.getTime() - 48 * 3600 * 1000) },
    })
      .limit(25)
      .lean();
    let engaged = 0;
    for (const lead of candidates) {
      const gw = goldenWindowFor(lead.createdAt, now, goldenCfg);
      if (gw.inWindow) continue; // still fresh — the team gets first shot
      if (await engageLead(lead, "golden_window_missed", now)) engaged++;
    }
    return { engaged };
  } catch (e) {
    console.error("KiaraSafetyNet.sweep failed:", e.message);
    return { engaged: 0 };
  }
};

module.exports = { maybeEngageOnCreate, sweepGoldenWindowMisses, engageLead, metaPhone };

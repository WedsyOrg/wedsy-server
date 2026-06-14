const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const ActivityLog = require("../models/ActivityLog");

const err = (status, message) => Object.assign(new Error(message), { status });

const EVENT_TITLES = {
  re_enquired: "Enquired again",
  auto_assigned: "Auto-assigned",
  assignment_failed: "Auto-assignment failed",
  call_logged: "Call logged",
  follow_up_scheduled: "Follow-up scheduled",
  follow_up_completed: "Follow-up completed",
  qualification_updated: "Qualification updated",
  call_completed: "Call wrapped up",
  unresponsive_flagged: "Flagged unresponsive",
  recycled: "Recycled",
  resurfaced: "Resurfaced",
  resurfaced_by_reenquiry: "Resurfaced — they re-enquired",
  converted_to_project: "Converted to project ✦",
  transferred: "Transferred",
  tags_changed: "Tags changed",
  custom_fields_updated: "Custom fields updated",
  // Kiara (WhatsApp AI agent) moments.
  wa_conversation_started: "WhatsApp conversation started",
  wa_escalated: "Kiara asked for a human",
  wa_human_takeover: "Human took over the chat",
  wa_handed_back: "Handed back to Kiara",
  wa_qualified_by_kiara: "Qualified by Kiara ✦",
  wa_classified: "Classified by Kiara",
  wa_admin_message_sent: "WhatsApp message sent",
  wa_template_sent: "Re-engage template sent",
  // Kiara on Instagram (MB6 Slice 7).
  ig_conversation_linked: "Instagram chat linked",
  ig_escalated: "Kiara asked for a human (Instagram)",
  ig_human_takeover: "Human took over the Instagram chat",
  ig_handed_back: "Handed back to Kiara (Instagram)",
  ig_qualified_by_kiara: "Qualified by Kiara on Instagram ✦",
  ig_classified: "Classified by Kiara (Instagram)",
  ig_admin_message_sent: "Instagram DM sent",
  // MB5/6 moments.
  triage_entered: "Landed in triage",
  triage_assigned: "Assigned from triage",
  triage_escalated: "Triage escalation",
  triage_auto_assigned: "Auto-assigned from triage",
  meet_handoff: "Handed to the sales lead for the meet",
  meeting_closed: "Meeting closed with notes",
  huddle_completed: "Huddle complete — team onboarded 🤝",
  kiara_safety_net_engaged: "Kiara safety net engaged ✦",
  meet_refused: "Refusing a meeting — tagged no-meet",
  // MB7a — onboarding & money engine.
  client_finalised: "Client finalised the plan",
  wedsy_approved: "Wedsy approved the plan ✦",
  agreement_signed: "Agreement accepted",
  onboarding_started: "Onboarding started",
  onboarding_payment_recorded: "Onboarding payment received ✦",
  onboarded: "Onboarded — client is live ✦",
  payment_recorded: "Payment recorded",
};

// Payload keys that carry an Admin id of a SECOND party (not the actor) — these
// must be name-resolved so titles can read "from A to B". Slice 4 (design pass).
const PARTY_ID_KEYS = [
  "from", "to", "assignedTo", "internId", "managerId",
  "originalOwnerId", "reassignedTo", "by", "decidedBy",
];

// Build the human title for an event, naming every party involved. `nameOf`
// resolves ids → names; `payloadName(key)` prefers an explicit *Name field in
// the payload, falling back to the resolved id. Returns null to use the static
// EVENT_TITLES map.
const dynamicTitle = (type, payload = {}, nameOf) => {
  const id = (key) => (payload[key] ? nameOf.get(String(payload[key])) || "someone" : null);
  // Prefer denormalized names captured at write time, else resolve the id.
  const toName = payload.toName || id("to") || payload.assignedToName || id("assignedTo");
  const fromName = payload.fromName || id("from");

  switch (type) {
    case "transferred":
      if (payload.reason === "meet_handoff") {
        return `Auto-transferred${fromName ? ` from ${fromName}` : ""} to ${toName || "the sales lead"} — meeting booked`;
      }
      return `Transferred${fromName ? ` from ${fromName}` : ""}${toName ? ` to ${toName}` : ""}`;
    case "meet_handoff":
      return `Auto-transferred from ${payload.internName || id("internId") || "the intern"} to ${payload.managerName || id("managerId") || "the manager"} — meeting booked`;
    case "auto_assigned":
      return `Auto-assigned${toName ? ` to ${toName}` : ""}`;
    case "triage_assigned":
      return payload.self ? "Took it from triage" : `Assigned from triage${toName ? ` to ${toName}` : ""}`;
    case "triage_auto_assigned":
      return `Auto-assigned from triage${toName ? ` to ${toName}` : ""}`;
    case "resurfaced_by_reenquiry": {
      const re = payload.reassignedTo ? id("reassignedTo") : null;
      return `Resurfaced — they re-enquired${re ? ` · back to ${re}` : ""}`;
    }
    default:
      return null;
  }
};

// GET /enquiry/:_id/journey — every moment of a lead's life, one chronological
// stream, normalized to { at, type, actor, title, detail }.
const buildJourney = async (enquiryId) => {
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) throw err(400, "Invalid enquiry id");
  const lead = await Enquiry.findById(enquiryId).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const [internalEvents, activityRows] = await Promise.all([
    LeadInternalEvent.find({ leadId: lead._id }).lean(),
    // Read-only reuse of the PR #25/#26 ActivityLog stream for this lead.
    ActivityLog.find({ entityType: "lead", entityId: String(lead._id) }).lean(),
  ]);

  // Resolve every actor name in one query — actors AND named payload parties
  // (transfer from/to, handoff intern/manager, …) so titles can name everyone.
  const actorIds = new Set();
  for (const e of internalEvents) {
    if (e.actorId) actorIds.add(String(e.actorId));
    const p = e.payload || {};
    for (const k of PARTY_ID_KEYS) {
      if (p[k] && mongoose.Types.ObjectId.isValid(String(p[k]))) actorIds.add(String(p[k]));
    }
  }
  for (const a of activityRows) if (a.actorId) actorIds.add(String(a.actorId));
  for (const c of lead.callLog || []) if (c.loggedBy) actorIds.add(String(c.loggedBy));
  for (const f of lead.followUps || []) {
    if (f.createdBy) actorIds.add(String(f.createdBy));
    if (f.completedBy) actorIds.add(String(f.completedBy));
  }
  const admins = actorIds.size
    ? await Admin.find({ _id: { $in: [...actorIds] } }, { name: 1 }).lean()
    : [];
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));
  const actor = (id) => (id ? nameOf.get(String(id)) || "—" : "system");

  const entries = [];

  // Birth entry: creation + source + every ad-form answer.
  entries.push({
    at: lead.createdAt,
    type: "created",
    actor: "system",
    title: lead.importedAt ? "Imported into the CRM" : "Lead captured",
    detail: {
      source: lead.marketingSource || lead.source || "",
      adFormAnswers: lead.additionalInfo?.adFormAnswers || null,
    },
  });

  for (const e of internalEvents) {
    entries.push({
      at: e.createdAt,
      type: e.type,
      actor: actor(e.actorId),
      // Name every party: dynamic actor-aware title first, static map as fallback.
      title: dynamicTitle(e.type, e.payload || {}, nameOf) || EVENT_TITLES[e.type] || e.type,
      detail: e.payload || {},
    });
  }

  for (const a of activityRows) {
    entries.push({
      at: a.createdAt,
      type: a.action,
      actor: actor(a.actorId),
      title: a.summary || a.action,
      detail: a.meta || {},
    });
  }

  for (const c of lead.callLog || []) {
    entries.push({
      at: c.startedAt,
      type: "call",
      actor: actor(c.loggedBy),
      title: `Call — ${c.outcome || (c.connected ? "connected" : "attempted")}`,
      detail: {
        durationSeconds: c.durationSeconds || 0,
        connected: !!c.connected,
        outcome: c.outcome || "",
        notes: c.notes || "",
      },
    });
  }

  for (const f of lead.followUps || []) {
    entries.push({
      at: f.createdAt,
      type: "follow_up_created",
      actor: actor(f.createdBy),
      title: `Next step booked — ${f.type}`,
      detail: { followUpType: f.type, scheduledAt: f.scheduledAt, promiseNote: f.promiseNote || "" },
    });
    if (f.completedAt) {
      entries.push({
        at: f.completedAt,
        type: "follow_up_done",
        actor: actor(f.completedBy),
        title: `Follow-up done — ${f.completedOutcome || "completed"}`,
        detail: { followUpType: f.type, outcome: f.completedOutcome || "", notes: f.completedNotes || "" },
      });
    }
  }

  entries.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { leadId: lead._id, name: lead.name, entries };
};

module.exports = { buildJourney };

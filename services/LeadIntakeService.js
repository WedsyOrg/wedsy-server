const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const LeadAssignmentService = require("./LeadAssignmentService");
const AdminNotificationService = require("./AdminNotificationService");

const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Normalize to the last 10 digits (Indian local number) for dedup matching —
// catches "+91 98765 43210" vs "9876543210" style duplicates the exact-match
// checks in the existing intake paths can't see.
const normalizePhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// Existing lead whose phone ends with the normalized number (null if too short to trust).
const findExistingByNormalizedPhone = async (phone) => {
  const normalized = normalizePhone(phone);
  if (normalized.length < 7) return null;
  return await Enquiry.findOne({ phone: { $regex: escapeRegExp(normalized) + "$" } });
};

// Dedup-merge: an existing lead enquired again. No duplicate is created — we stamp
// reEnquiredAt (drives the dashboard 🔥 badge for 7 days) and append a re_enquired
// event carrying where/what they asked. Never throws (intake must not fail on it).
//
// Terminal-state handling (lifecycle hardening):
//   recycled → a re-enquiry IS the revisit: clear the recycle flags, hand the lead
//              back to its original owner (or the round-robin), event
//              "resurfaced_by_reenquiry".
//   lost     → keep the stage; reEnquiredAt feeds the dashboard's
//              "Returned — they came back" card (last 14 days) with a manager Reopen.
//   won      → already a client; event only, no badge.
const recordReEnquiry = async (enquiryId, { source, message, adFormAnswers } = {}) => {
  try {
    const lead = await Enquiry.findById(enquiryId).lean();
    if (!lead) return;

    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "re_enquired",
      actorId: null,
      payload: {
        source: source || "",
        message: message || "",
        // Slice 4: a re-enquiry from an ad form carries its new answers.
        ...(adFormAnswers ? { adFormAnswers } : {}),
      },
    });

    if (lead.stage === "won") {
      return; // event only — they're a client, not a lead
    }

    await Enquiry.findByIdAndUpdate(enquiryId, { $set: { reEnquiredAt: new Date() } });

    if (lead.recycled && lead.recycled.isRecycled) {
      // The customer beat the revisit date — resurface NOW.
      const flipped = await Enquiry.findOneAndUpdate(
        { _id: enquiryId, "recycled.isRecycled": true },
        { $set: { "recycled.isRecycled": false, "recycled.resurfacedAt": new Date() } },
        { new: true }
      );
      if (flipped) {
        const Admin = require("../models/Admin");
        let reassignedTo = null;
        const originalOwner = lead.recycled.originalOwnerId
          ? await Admin.findById(lead.recycled.originalOwnerId).lean()
          : null;
        if (originalOwner && originalOwner.status === "active") {
          await Enquiry.findByIdAndUpdate(enquiryId, { $set: { assignedTo: originalOwner._id } });
          reassignedTo = originalOwner._id;
        } else {
          const assignee = await LeadAssignmentService.assignLead(enquiryId);
          reassignedTo = assignee ? assignee._id : null;
        }
        await LeadInternalEventService.record({
          leadId: enquiryId,
          type: "resurfaced_by_reenquiry",
          actorId: null,
          payload: {
            source: source || "",
            originalOwnerId: lead.recycled.originalOwnerId ? String(lead.recycled.originalOwnerId) : null,
            reassignedTo: reassignedTo ? String(reassignedTo) : null,
          },
        });
      }
    }
  } catch (e) {
    console.error("LeadIntakeService.recordReEnquiry failed:", e.message);
  }
};

// Best-effort INTERNAL OS notification (never the external NotificationService) the
// moment a lead is created — speed-to-lead alerting for staff. Recipient is resolved
// from the assignment outcome: an assignee came back → ping that person; otherwise the
// lead is sitting unassigned (triage mode, auto-assign off, or no pool capacity) → ping
// the triage holders so it doesn't age silently. AdminNotificationService.notify is
// itself fire-safe and no-ops on an empty recipient list; this wrapper adds a second
// guard so the create path can never be broken by notification work. Fires ONCE per
// lead, from afterCreate only.
const notifyNewLead = async (enquiryId, assignee) => {
  try {
    const lead = await Enquiry.findById(enquiryId, { name: 1, source: 1 }).lean();
    if (!lead) return;
    const assigned = !!(assignee && assignee._id);
    // Lazy-require TriageService to match the existing late-require pattern here and
    // sidestep any service load-order coupling.
    const recipient = assigned
      ? assignee._id
      : await require("./TriageService").triageHolderIds();
    const source = lead.source || "";
    const message = assigned
      ? `Assigned to you — call now, golden window is ticking.${source ? ` Source: ${source}.` : ""}`
      : `Waiting in triage — grab it fast.${source ? ` Source: ${source}.` : ""}`;
    await AdminNotificationService.notify(recipient, {
      type: "new_lead",
      title: `New lead: ${lead.name}`,
      message,
      leadId: enquiryId,
      payload: { source, assigned },
    });
  } catch (e) {
    console.error("LeadIntakeService.notifyNewLead failed:", e.message);
  }
};

// Post-create hook for genuinely-new leads: auto-assignment. Runs AFTER the existing
// (venue-hardened) validation and insert — additive only, never blocks the response.
const afterCreate = async (enquiryId) => {
  let assignee = null;
  try {
    // assignLead returns the chosen admin (auto mode) or null (triage / disabled /
    // no capacity). We branch the new-lead notification on this outcome.
    assignee = await LeadAssignmentService.assignLead(enquiryId);
  } catch (e) {
    console.error("LeadIntakeService.afterCreate failed:", e.message);
  }
  // Internal OS new-lead notification — additive, fire-safe; runs after assignment so
  // the recipient is known. Self-insulated (own try/catch); can never throw into create.
  await notifyNewLead(enquiryId, assignee);
  // MB5 Slice 5: Kiara safety net — after-hours creates get the welcome
  // template immediately. Template-gated (dormant when unset); fire-safe.
  try {
    await require("./KiaraSafetyNetService").maybeEngageOnCreate(enquiryId);
  } catch (e) {
    console.error("LeadIntakeService.afterCreate safety net failed:", e.message);
  }
};

// The ONE create path for hook/intake-created leads (WhatsApp, Instagram, …).
// Mirrors the CreateNew controller's create branch and PINS the board/list-
// critical fields explicitly (stage and the boolean flags), so an intake-created
// lead can never be shaped differently from a manually created one — the board
// renders only configured stage columns, so a lead with a missing/unknown stage
// silently disappears from it.
const createLead = async ({ name, phone, verified = false, source, additionalInfo = {} }) => {
  const created = await new Enquiry({
    name,
    phone,
    verified,
    source,
    additionalInfo,
    stage: "new",
    isInterested: false,
    isLost: false,
  }).save();
  await afterCreate(created._id);
  return created;
};

module.exports = {
  normalizePhone,
  findExistingByNormalizedPhone,
  recordReEnquiry,
  afterCreate,
  createLead,
};

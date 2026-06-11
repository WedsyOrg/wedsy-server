const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const LeadAssignmentService = require("./LeadAssignmentService");

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
const recordReEnquiry = async (enquiryId, { source, message } = {}) => {
  try {
    const lead = await Enquiry.findById(enquiryId).lean();
    if (!lead) return;

    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "re_enquired",
      actorId: null,
      payload: { source: source || "", message: message || "" },
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

// Post-create hook for genuinely-new leads: auto-assignment. Runs AFTER the existing
// (venue-hardened) validation and insert — additive only, never blocks the response.
const afterCreate = async (enquiryId) => {
  try {
    await LeadAssignmentService.assignLead(enquiryId);
  } catch (e) {
    console.error("LeadIntakeService.afterCreate failed:", e.message);
  }
};

module.exports = {
  normalizePhone,
  findExistingByNormalizedPhone,
  recordReEnquiry,
  afterCreate,
};

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
const recordReEnquiry = async (enquiryId, { source, message } = {}) => {
  try {
    await Enquiry.findByIdAndUpdate(enquiryId, { $set: { reEnquiredAt: new Date() } });
    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "re_enquired",
      actorId: null,
      payload: { source: source || "", message: message || "" },
    });
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

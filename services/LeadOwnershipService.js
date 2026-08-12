const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const AdminNotificationService = require("./AdminNotificationService");

// ── THE ownership choke-point ────────────────────────────────────────────────
// Every routed owner change goes through reassignOwner so the "new owner gets
// told" rule lives in exactly one place instead of drifting across call sites.
//
// Deliberately NOT in here: journey/internal events. Each caller records its own
// (`transferred`, `auto_assigned`, `triage_assigned`, …) with a bespoke payload,
// and duplicating that here would double-record. This owns the WRITE and the
// NOTIFICATION only.

const NOTIFICATION_TYPE = "assignment";

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const sameId = (a, b) => String(a || "") === String(b || "");

// Mirrors EnquiryService.updateAssignedTo's target checks (the manual-assign
// path) so every routed site enforces the same rule: a stale dropdown can never
// park a lead on an admin who has since been deactivated or disabled.
const assertAssignable = async (newOwnerId) => {
  const admin = await Admin.findById(newOwnerId).lean();
  if (!admin) throw httpError(404, "Admin not found");
  if (admin.status !== "active" || admin.isDisabled) {
    throw httpError(422, "Target admin cannot receive leads (inactive or disabled)");
  }
  return admin;
};

// Fire-safe notification half (the Instagram-agent pattern): the owner write has
// already committed by the time this runs, and nothing in here can throw out.
const notifyNewOwner = async (lead, oldOwnerId, newOwnerId, actorId, reason) => {
  try {
    // The previous owner's "assigned to you" row is now false — retire it so a
    // rapid A→B→C leaves exactly ONE unread assignment row, on the final owner.
    // This is NOT a notification to the old owner; it only clears a stale one.
    if (oldOwnerId && !sameId(oldOwnerId, newOwnerId)) {
      await AdminNotificationService.clearUnread(oldOwnerId, {
        type: NOTIFICATION_TYPE,
        leadId: lead._id,
      });
    }
    // Unassign (→ null): the stale row above is retired, but there is nobody to tell.
    if (!newOwnerId) return false;
    // Self-assign: you know what you just did to yourself.
    if (sameId(actorId, newOwnerId)) return false;

    // notifyOnce → at most one unread assignment row per (owner, lead), so a
    // burst of reassignments onto the same person collapses instead of stacking.
    await AdminNotificationService.notifyOnce(newOwnerId, {
      type: NOTIFICATION_TYPE,
      title: `${lead.name} assigned to you`,
      message: "Reassigned to you — pick it up from here.",
      leadId: lead._id,
      payload: {
        leadId: String(lead._id),
        from: oldOwnerId ? String(oldOwnerId) : null,
        by: actorId ? String(actorId) : null,
        reason: reason || "",
      },
    });
    return true;
  } catch (e) {
    console.error("[LeadOwnership] new-owner notification failed:", e.message);
    return false;
  }
};

// Change a lead's owner. Returns { changed, notified, oldOwner, lead }.
//
// opts:
//   notify               (true)  — set false when the caller already sends its own
//                                  (e.g. lead creation, covered by `new_lead`).
//   reason               ("")    — free text, lands in payload.reason.
//   skipTargetValidation (false) — set true when the caller ALREADY ran the same
//                                  assignable check, so a 200-lead batch does not
//                                  re-query the same admin 200 times.
const reassignOwner = async (enquiryId, newOwnerId, actorId, opts = {}) => {
  const { notify = true, reason = "", skipTargetValidation = false } = opts;

  if (!isId(enquiryId)) throw httpError(400, "Invalid enquiry id");
  // null is legal and means "unassign" — same contract as the manual-assign path.
  const nextOwner = newOwnerId == null ? null : newOwnerId;
  if (nextOwner !== null && !isId(nextOwner)) {
    throw httpError(400, "Invalid assignedTo: must be an Admin _id or null");
  }

  const lead = await Enquiry.findById(enquiryId).lean();
  if (!lead) throw httpError(404, "Enquiry not found");

  // CHANGE DETECTION — a same-owner call writes nothing and notifies nothing.
  if (sameId(lead.assignedTo, nextOwner)) {
    return { changed: false, notified: false, oldOwner: lead.assignedTo || null, lead };
  }

  if (nextOwner !== null && !skipTargetValidation) await assertAssignable(nextOwner);

  const oldOwner = lead.assignedTo || null;
  const updated = await EnquiryRepository.updateAssignedToById(enquiryId, nextOwner, actorId || null);
  if (!updated) throw httpError(404, "Enquiry not found");

  // Unassigning has no recipient; there is still a stale row to retire.
  let notified = false;
  if (notify) notified = await notifyNewOwner(lead, oldOwner, nextOwner, actorId, reason);

  return { changed: true, notified, oldOwner, lead: updated };
};

module.exports = { reassignOwner, NOTIFICATION_TYPE };

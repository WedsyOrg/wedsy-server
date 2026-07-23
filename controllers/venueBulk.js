/**
 * controllers/venueBulk.js
 *
 * Bulk operations over a venue's leads (venueOwnerAuth + ownership enforced):
 *   POST /venues/:slug/enquiries/bulk          { enquiryIds[], action, value }
 *   POST /venues/:slug/enquiries/bulk-whatsapp { enquiryIds[], templateId | body }
 *
 * Per-item errors are collected, never thrown, so a partial batch still applies.
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueMessageTemplate = require("../models/VenueMessageTemplate");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const venueWhatsApp = require("../utils/venueWhatsApp");
const { hasCapability } = require("../utils/venueRbac");
const { validateAssignable } = require("../utils/venueLeadAssign");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");

const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

const STAGE_ENUM = [
  "new", "contacted", "site_visit_scheduled", "site_visit_done",
  "proposal_sent", "negotiating", "booked", "lost",
];
const BULK_ACTIONS = ["assign", "stage", "note"];

// Resolve the owned venue from slug; returns venue or sends an error response.
async function resolveOwnedVenue(req, res) {
  const { slug } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id name contact").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

// POST /venues/:slug/enquiries/bulk
const bulkAction = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { enquiryIds, action, value } = req.body || {};
    if (!Array.isArray(enquiryIds) || enquiryIds.length === 0) {
      return res.status(400).json({ message: "enquiryIds[] is required" });
    }
    if (!BULK_ACTIONS.includes(action)) {
      return res.status(400).json({ message: `action must be one of ${BULK_ACTIONS.join(", ")}` });
    }
    if (action === "stage" && !STAGE_ENUM.includes(value)) {
      return res.status(400).json({ message: `value must be a valid stage (${STAGE_ENUM.join(", ")})` });
    }
    if (action === "assign" && (typeof value !== "string" || !value.trim())) {
      return res.status(400).json({ message: "value (assignee) is required for assign" });
    }
    if (action === "note" && (typeof value !== "string" || !value.trim())) {
      return res.status(400).json({ message: "value (note text) is required for note" });
    }

    // S0a/S0d: bulk assign is a reassignment — gate on leads_reassign and
    // validate the (single, batch-wide) target is an active member of this
    // venue up front, so a bad assignee 422s the whole batch (parks no lead).
    let assignId = null;
    if (action === "assign") {
      if (!(await hasCapability(req.venueOwner, "leads_reassign", req.venueMember))) {
        return res.status(403).json({ message: "You don't have permission to reassign leads" });
      }
      const v = await validateAssignable(venue._id, value.trim());
      if (!v.ok) return res.status(422).json({ message: v.message });
      assignId = v.id;
    }
    if (action === "stage" && !(await hasCapability(req.venueOwner, "leads_change_stage", req.venueMember))) {
      return res.status(403).json({ message: "You don't have permission to change lead stage" });
    }

    let updated = 0;
    let skipped = 0;
    const errors = [];
    for (const id of enquiryIds) {
      try {
        // Scoped: out-of-scope (or non-existent) ids are silently skipped so a
        // member can't mutate another member's leads via a bulk id list.
        const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, id);
        if (!enquiry) {
          skipped += 1;
          continue;
        }
        if (action === "assign") {
          enquiry.assignedTo = assignId;
          enquiry.activities.push({ type: "manual_assigned", description: "Reassigned (bulk)", via: "bulk_reassign", actor: actorIdOf(req), timestamp: new Date() });
        } else if (action === "stage") {
          if (value !== enquiry.stage) {
            enquiry.activities.push({ type: "stage_changed", description: `Stage changed from ${enquiry.stage} to ${value}`, timestamp: new Date() });
            enquiry.stage = value;
          }
        } else if (action === "note") {
          enquiry.notes.push({ text: value.trim(), addedAt: new Date() });
          enquiry.activities.push({ type: "note_added", description: "Note added (bulk)", timestamp: new Date() });
        }
        await enquiry.save();
        updated += 1;
      } catch (e) {
        errors.push({ enquiryId: id, reason: e.message });
      }
    }
    return res.status(200).json({ updated, skipped, errors });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/enquiries/bulk-whatsapp
const bulkWhatsApp = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    if (!venueWhatsApp.isConfigured()) {
      return res.status(503).json({ configured: false, message: "WhatsApp Cloud API is not configured" });
    }

    const { enquiryIds, templateId, body } = req.body || {};
    if (!Array.isArray(enquiryIds) || enquiryIds.length === 0) {
      return res.status(400).json({ message: "enquiryIds[] is required" });
    }

    let messageBody = typeof body === "string" ? body.trim() : "";
    if (templateId) {
      const template = await VenueMessageTemplate.findOne({ _id: templateId, venue: venue._id }).lean();
      if (!template) return res.status(404).json({ message: "Template not found" });
      messageBody = template.body;
    }
    if (!messageBody) {
      return res.status(400).json({ message: "Provide a templateId or a non-empty body" });
    }

    let sent = 0;
    let skipped = 0;
    const failed = [];
    for (const id of enquiryIds) {
      try {
        // Scoped: silently skip ids outside the requester's visibility.
        const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, id);
        if (!enquiry) {
          skipped += 1;
          continue;
        }
        const phone = enquiry.couplePhone || enquiry.phone;
        if (!phone) {
          failed.push({ enquiryId: id, reason: "no phone on lead" });
          continue;
        }
        const result = await venueWhatsApp.sendText(phone, messageBody);
        if (!result.ok) {
          failed.push({ enquiryId: id, reason: result.error });
          continue;
        }
        await VenueLeadInteraction.create({
          enquiry: enquiry._id,
          venue: venue._id,
          type: "whatsapp",
          note: messageBody,
          createdBy: req.venueOwner.venueOwnerId,
        });
        sent += 1;
      } catch (e) {
        failed.push({ enquiryId: id, reason: e.message });
      }
    }
    return res.status(200).json({ sent, skipped, failed });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { bulkAction, bulkWhatsApp };

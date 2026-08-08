const mongoose = require("mongoose");

/**
 * models/VenueFollowUp.js — the follow-ups module (founder-decided upgrade from
 * the single followUpDate/followUpNote pair on VenueEnquiry).
 *
 * SHAPE DECISION — own collection, not subdocuments on the lead:
 *   1. The module's primary queries are CROSS-lead, not per-lead: "overdue
 *      across the venue", "due today", "assigned to me", "by pipeline stage".
 *      As subdocs every one of those is an $unwind over the whole enquiry
 *      collection; as a collection they are indexed single-collection reads.
 *   2. History is unbounded. The lead list is read unpaginated by the CRM, so
 *      subdocs would drag every historical follow-up of every lead into every
 *      list response forever.
 *   3. A follow-up's owner can differ from the lead's assignee (a manager
 *      schedules, a rep executes), so assignment needs its own index.
 *   4. The dashboard counts, the Follow-ups list and the lead's next-touch
 *      strip must agree by construction — one indexed source, not three
 *      derivations over a nested array.
 * The cost of a separate collection is that scope must be re-derived from the
 * parent lead on every read (a follow-up is lead-derived data, invariant #5).
 * That is paid once, in utils/venueFollowUp.js, and deny-swept in tests.
 *
 * VenueEnquiry.followUpDate / .followUpNote SURVIVE as a denormalised mirror of
 * the NEXT OPEN follow-up, maintained by syncLeadNextFollowUp(). Every existing
 * consumer (dashboards, digest, list rows, heat colour, portfolio) keeps
 * working untouched, and the "a lead never lacks a next step" loop still reads
 * the field it always read.
 */
const VenueFollowUpSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    // Every follow-up belongs to a lead — that is the point of the module.
    // (Standalone work items are Tasks; the two stay distinct.)
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true },
    type: {
      type: String,
      enum: ["call", "whatsapp", "email", "site_visit", "meeting", "other"],
      default: "call",
    },
    dueAt: { type: Date, required: true },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    // "What do I say when they pick up" — the note is the whole reason a rep
    // never has to call blind.
    note: { type: String, default: "" },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VenueTeamMember",
      default: null,
      set: (v) => (v === "" || v == null ? null : v),
    },
    status: { type: String, enum: ["open", "done", "cancelled"], default: "open" },
    // Captured on completion — "what happened" is what makes history useful.
    outcome: { type: String, default: "" },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId },
    cancelledAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId },
    cancelReason: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
    // Reschedules are history, not silent edits: a lead that has been pushed
    // five times is a different conversation from one scheduled once.
    reschedules: [
      {
        from: { type: Date },
        to: { type: Date },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId },
      },
    ],
    // Minutes before dueAt at which a reminder should fire. Null = no reminder.
    // Notifications are TRIGGERS only on this platform, so this is read by the
    // digest job — it is never a promise that a message was sent.
    reminderMinutesBefore: { type: Number, default: null },
    // Provenance for the one-time migration off the single followUpDate field.
    migratedFromLead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// The Follow-ups list + bucket counts (venue-wide, open first, by due date).
VenueFollowUpSchema.index({ venue: 1, status: 1, dueAt: 1 });
// "Assigned to me" / per-owner scoping.
VenueFollowUpSchema.index({ venue: 1, assignedTo: 1, status: 1, dueAt: 1 });
// The lead's own follow-up history + the next-open lookup behind the mirror.
VenueFollowUpSchema.index({ lead: 1, status: 1, dueAt: 1 });

module.exports =
  mongoose.models.VenueFollowUp || mongoose.model("VenueFollowUp", VenueFollowUpSchema);

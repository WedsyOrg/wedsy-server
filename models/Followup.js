const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB8c-2a-ii — a FOLLOW-UP: a scheduled CLIENT touch (someone reaches out to the
// couple), distinct from a LeadTask (internal work). Follow-ups get chat cards
// (client-cadence, worth surfacing); tasks stay quiet. status snoozed reverts to
// open once snoozedUntil passes — normalized at read time in the service.
const FollowupSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    title: { type: String, required: true },
    dueAt: { type: Date, required: true },
    // Who reaches out — from the lead's roster (MB8a). Optional (can be set later).
    ownerId: { type: ObjectId, ref: "Admin", default: null, index: true },
    status: { type: String, enum: ["open", "done", "snoozed"], default: "open", index: true },
    snoozedUntil: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: ObjectId, ref: "Admin", default: null },
    // Set once when the "due" chat card is posted, so it surfaces ONCE (not every
    // poll) — the non-spammy cadence.
    dueCardPostedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

FollowupSchema.index({ ownerId: 1, status: 1, dueAt: 1 });
FollowupSchema.index({ leadId: 1, status: 1 });

module.exports = mongoose.models.Followup || mongoose.model("Followup", FollowupSchema);

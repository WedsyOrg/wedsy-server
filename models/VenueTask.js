const mongoose = require("mongoose");

// MB-CRM S0c: a venue-owner CRM task. Tasks are STANDALONE or lead-linked
// (linkedEnquiry optional). createdBy/completedBy/assignedTo hold actor ids —
// assignedTo is a real VenueTeamMember ref (the assignment/scoping boundary),
// while createdBy/completedBy are loose ObjectIds because the actor may be the
// VenueOwner anchor OR a VenueTeamMember (mirrors VenueTeamMember.invitedBy).
const VenueTaskSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    title: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    dueAt: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "VenueTeamMember" },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
    // Optional link to a lead — tasks live with or without one.
    linkedEnquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" },
    status: { type: String, enum: ["open", "done"], default: "open" },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId },
    // BUILD B — WHERE this task came from. There is exactly ONE task system:
    // a follow-up spawned from a quote round is a normal VenueTask that shows
    // up in the normal Tasks list, labelled by origin, rather than living in a
    // parallel money to-do list nobody would remember to open. Defaults to
    // "manual" so every existing row keeps its present meaning.
    source: { type: String, enum: ["manual", "money"], default: "manual" },
    // The record that spawned it (a VenueQuoteRound for source="money").
    // Loose ObjectId rather than a hard ref because future sources will point
    // at other collections.
    sourceRef: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

VenueTaskSchema.index({ venue: 1, dueAt: 1 });
VenueTaskSchema.index({ venue: 1, assignedTo: 1, status: 1 });
VenueTaskSchema.index({ linkedEnquiry: 1 });
// "Which task did this round spawn?" — the Money tab's read.
VenueTaskSchema.index({ source: 1, sourceRef: 1 });

module.exports = mongoose.models.VenueTask || mongoose.model("VenueTask", VenueTaskSchema);

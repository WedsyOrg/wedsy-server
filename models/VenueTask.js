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
  },
  { timestamps: true }
);

VenueTaskSchema.index({ venue: 1, dueAt: 1 });
VenueTaskSchema.index({ venue: 1, assignedTo: 1, status: 1 });
VenueTaskSchema.index({ linkedEnquiry: 1 });

module.exports = mongoose.models.VenueTask || mongoose.model("VenueTask", VenueTaskSchema);

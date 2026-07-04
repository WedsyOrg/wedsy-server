const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── MB8a Slice 1 — the lead TEAM ROSTER (Client Journey Engine foundation) ────
// A lead can have a team: a roster of members drawn from the company's
// departments, assembled by the sales lead (the lead's owner) or anyone with a
// broader manage-team scope (Revenue Head) after their offline huddle.
//
// APPEND-ONLY by design. A row is NEVER hard-deleted:
//   • CURRENT team  = rows with activeTo == null.
//   • HISTORY       = the full sequence; removing a member sets activeTo +
//                     removedBy and keeps the record. Re-adding the same person
//                     writes a fresh row.
// There are intentionally NO update/hard-delete repository helpers.
//
// A dedicated collection (NOT embedded on Enquiry) because: the gated Enquiry
// document stays untouched; the append-only history is unbounded and shouldn't
// bloat the hot lead doc; and "leads I'm on the team for" is a cheap indexed
// read ({ personId, activeTo: null }). Mirrors the existing VenueTeamMember shape.
const LeadTeamMemberSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true },
    personId: { type: ObjectId, ref: "Admin", required: true },
    // The department this person is SERVING on this lead. An admin can belong to
    // multiple departments (via their roles) — this captures which one applies
    // here. Name is denormalized at write time so history reads survive renames.
    departmentId: { type: ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "" },
    // Slice B1 — how this member relates to the lead. "qualifier" = the
    // pre-handoff owner auto-kept at the qualify hinge (the FE badges them as
    // the secondary owner). "" = a normal department member.
    role: { type: String, enum: ["", "qualifier"], default: "" },
    addedBy: { type: ObjectId, ref: "Admin", default: null },
    addedAt: { type: Date, default: Date.now },
    activeFrom: { type: Date, default: Date.now },
    // null == still on the team. Set (with removedBy) when removed — never deleted.
    activeTo: { type: Date, default: null },
    removedBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// Current-team reads and "leads I'm on" reads are the hot paths.
LeadTeamMemberSchema.index({ leadId: 1, activeTo: 1 });
LeadTeamMemberSchema.index({ personId: 1, activeTo: 1 });

module.exports =
  mongoose.models.LeadTeamMember ||
  mongoose.model("LeadTeamMember", LeadTeamMemberSchema);

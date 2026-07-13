const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Slice B3 — a WORKSTREAM LANE on a qualified lead. Lanes are the post-qualify
// working surface: one per workstream (venue / decor / makeup / …), each with
// ONE owner, a lifecycle state, and an optional wake rule for queued lanes.
//
// key: a canonical library key (venue|decor|makeup|vendors|engagement|
// lead_comms|kickoff) or "custom:<slug>" for ad-hoc lanes. lead_comms is the
// single-voice-to-the-couple lane — its owner is ALWAYS the lead owner
// (enforced in LeadLaneService, never trusted from the client).
//
// state: queued (waiting on wake) | active | paused (waiting on client, with
// pausedReason) | done. Silence escalation (Slice B4) reads lastUpdateAt on
// ACTIVE lanes only.
const LeadLaneSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    departmentId: { type: ObjectId, ref: "Department", default: null },
    // null = unassigned (the sweep treats an unassigned ACTIVE lane as already
    // escalated to the lead owner + Revenue Heads).
    ownerId: { type: ObjectId, ref: "Admin", default: null, index: true },
    state: { type: String, enum: ["queued", "active", "paused", "done"], default: "active" },
    // Wake rule — only meaningful while queued; null once active.
    wake: {
      type: {
        type: String,
        enum: ["afterLane", "onDate", "manual"],
      },
      laneKey: { type: String },
      at: { type: Date },
    },
    lastUpdateAt: { type: Date, default: Date.now },
    pausedReason: { type: String, default: "" },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
    doneAt: { type: Date, default: null },
    // Journey v2 (V3) — per-lane money. Proposed by the lane owner (or lead
    // owner/manager), CONFIRMED by the lead owner/manager only. Null until the
    // first propose. An unpriced lane past meeting_held is the "₹ TBD blocks
    // proposal" signal (exposed as priced:false on lane payloads).
    price: {
      type: new mongoose.Schema(
        {
          amount: { type: Number, default: null },
          status: { type: String, enum: ["proposed", "confirmed"], default: "proposed" },
          proposedBy: { type: ObjectId, ref: "Admin", default: null },
          proposedAt: { type: Date, default: null },
          confirmedBy: { type: ObjectId, ref: "Admin", default: null },
          confirmedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

LeadLaneSchema.index({ leadId: 1, key: 1 }, { unique: true });
LeadLaneSchema.index({ state: 1, lastUpdateAt: 1 });

module.exports = mongoose.models.LeadLane || mongoose.model("LeadLane", LeadLaneSchema);

const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Slice B4 — sweep dedupe. One mark per FIRED escalation rung per silence
// episode: key = "<kind>:<leadId>:<laneKeyOrStation>:<rung>:<sinceEpochMs>".
// A fresh update moves the episode anchor (lastUpdateAt / station anchor), the
// key changes, and the ladder may fire again — but never twice for the same
// episode. Marks are tiny and append-only; no TTL (they double as an audit).
const EscalationMarkSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    kind: { type: String, enum: ["lane", "deal"], required: true },
    rung: { type: Number, required: true },
    firedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.EscalationMark || mongoose.model("EscalationMark", EscalationMarkSchema);

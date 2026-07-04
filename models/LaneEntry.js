const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Slice B3 — one row in a lane's thread. kind "update" = a human post (the
// lane's heartbeat — resets the silence clock); kind "auto" = a system echo
// (call logged, meeting booked, task done, lane woken, proposal/agreement/
// payment milestones) so the lane reads as a complete story.
const LaneEntrySchema = new mongoose.Schema(
  {
    laneId: { type: ObjectId, ref: "LeadLane", required: true, index: true },
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    kind: { type: String, enum: ["update", "auto"], required: true },
    text: { type: String, required: true },
    authorId: { type: ObjectId, ref: "Admin", default: null }, // null for auto
    autoType: {
      type: String,
      enum: ["", "call_logged", "meeting_booked", "task_done", "lane_woken", "proposal_sent", "agreement", "payment", "lane_opened"],
      default: "",
    },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

LaneEntrySchema.index({ laneId: 1, at: -1 });

module.exports = mongoose.models.LaneEntry || mongoose.model("LaneEntry", LaneEntrySchema);

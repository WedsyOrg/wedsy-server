const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// C4 — INSTAGRAM PLANNER (CS workspace). One card on the content board:
// ideas → shortlisted → next_week → this_week → posted. The Monday roll
// promotes next_week → this_week (order preserved); a this_week card that
// missed its week is stamped overdue and flagged ONCE to CS managers
// (flaggedAt). Posting stamps postedAt + onTime (= !overdue at post time).
const ContentPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    desc: { type: String, default: "" },
    column: {
      type: String,
      enum: ["ideas", "shortlisted", "next_week", "this_week", "posted"],
      default: "ideas",
      index: true,
    },
    // Day slot inside a week column (null = unslotted; null must be IN the
    // enum for mongoose to accept an explicit null write).
    slot: { type: String, enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", null], default: null },
    order: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
    postedAt: { type: Date, default: null },
    // Set when posted: was it on time (never went overdue)?
    onTime: { type: Boolean, default: null },
    overdue: { type: Boolean, default: false },
    // One-time "was due last week" flag stamp (dedupes the manager alert).
    flaggedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
ContentPostSchema.index({ column: 1, order: 1 });

module.exports = mongoose.models.ContentPost || mongoose.model("ContentPost", ContentPostSchema);

const mongoose = require("mongoose");

const StageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },         // display name e.g. "Meeting Scheduled"
    slug: { type: String, required: true, unique: true }, // stored value e.g. "meeting_scheduled"
    order: { type: Number, required: true, default: 0 },  // column/sort position
    color: { type: String, default: "#4B1528" },
    category: { type: String, enum: ["open", "won", "lost"], default: "open" },
    isSystem: { type: Boolean, default: false },     // system stages can't be deleted
    deletedAt: { type: Date, default: null },         // soft delete
  },
  { timestamps: true }
);

StageSchema.index({ order: 1 });

module.exports = mongoose.models.Stage || mongoose.model("Stage", StageSchema);

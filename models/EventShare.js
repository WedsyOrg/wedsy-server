const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const EventShareSchema = new mongoose.Schema(
  {
    event: { type: ObjectId, ref: "Event", required: true, index: true },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    relationship: { type: String, default: "" },
    tokenHash: { type: String, required: true, index: true },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: ObjectId, default: null }, // Admin/User id (optional)
    createdByModel: { type: String, default: "" }, // "Admin" | "User" (optional)
  },
  { timestamps: true }
);

EventShareSchema.index({ event: 1, tokenHash: 1 }, { unique: true });

module.exports = mongoose.model("EventShare", EventShareSchema);



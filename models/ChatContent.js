const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const ChatContentSchema = new mongoose.Schema(
  {
    chat: { type: ObjectId, ref: "Chat", required: true },
    contentType: { type: String, default: "" },
    // BiddingBid/BiddingOffer/Text/PersonalPackageAccepted
    content: { type: String, default: "" },
    other: { type: Object, default: {} },
    sender: {
      id: { type: ObjectId, required: false, default: null },
      role: {
        type: String,
        enum: ["", "user", "vendor", "admin"],
        default: "",
      },
    },
    status: {
      viewedByUser: { type: Boolean, default: false },
      viewedByVendor: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatContent", ChatContentSchema);

// Performance indexes
try {
  ChatContentSchema.index({ chat: 1, createdAt: -1 });
  ChatContentSchema.index({ chat: 1, "status.viewedByUser": 1, "status.viewedByVendor": 1 });
} catch (e) {}
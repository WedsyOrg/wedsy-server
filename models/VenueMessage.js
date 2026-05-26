const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VenueMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: ObjectId,
      ref: "VenueConversation",
      required: true,
    },
    senderId: { type: ObjectId, required: true },
    senderType: {
      type: String,
      enum: ["couple", "venue"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["text", "package", "quote", "gallery"],
      default: "text",
    },
    content: {
      text: { type: String, default: "" },
    },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

VenueMessageSchema.index({ conversationId: 1 });

module.exports =
  mongoose.models.VenueMessage ||
  mongoose.model("VenueMessage", VenueMessageSchema);

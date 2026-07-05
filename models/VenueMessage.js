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
    // MB-V2 D4 (additive): "wedsy" = a Wedsy-team intervention. Legacy values
    // and their required-ness are unchanged.
    senderType: {
      type: String,
      enum: ["couple", "venue", "wedsy"],
      required: true,
    },
    // MB-V2 D4 (additive): "offer" = structured deal card (see `offer` below).
    messageType: {
      type: String,
      enum: ["text", "package", "quote", "gallery", "offer"],
      default: "text",
    },
    content: {
      text: { type: String, default: "" },
    },
    // MB-V2 D4 — intervention targeting. Only meaningful for senderType
    // "wedsy"; couple/venue messages are always visible to both (default).
    target: {
      type: String,
      enum: ["both", "couple_only", "venue_only"],
      default: "both",
    },
    // MB-V2 D4 — structured offer payload (messageType "offer").
    offer: {
      title: { type: String, default: "" },
      body: { type: String, default: "" },
      validUntil: { type: Date },
    },
    // MB-V2 D4 — keyword-flag routing: terms matched at insert time (empty = clean).
    flaggedTerms: { type: [String], default: [] },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

VenueMessageSchema.index({ conversationId: 1 });

module.exports =
  mongoose.models.VenueMessage ||
  mongoose.model("VenueMessage", VenueMessageSchema);

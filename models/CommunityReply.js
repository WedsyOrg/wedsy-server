const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const CommunityReplySchema = new mongoose.Schema(
  {
    community: {
      type: ObjectId,
      ref: "Community",
      required: true,
    },
    reply: {
      type: String,
      required: true,
    },
    author: {
      anonymous: { type: Boolean, default: false },
      id: { type: ObjectId, required: true },
      role: {
        type: String,
        enum: ["", "user", "vendor", "admin"],
        default: "",
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CommunityReply", CommunityReplySchema);

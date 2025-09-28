const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const ChatSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: "Vendor", required: true },
    user: { type: ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Chat", ChatSchema);

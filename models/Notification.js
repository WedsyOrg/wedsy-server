const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    references: { type: Object, default: {} },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    read: { type: Boolean, default: false },
    type: { 
      type: String, 
      enum: ["bidding", "message", "order", "system"],
      default: "system"
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", NotificationSchema);

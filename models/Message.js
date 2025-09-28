const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
    },
    messageFor: {
      type: String,
      required: true,
      enum: ["Vendor", "Customer", "Both (Vendor, Customer)"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", MessageSchema);

const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VendorStatLogSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, required: true, ref: "Vendor" },
    user: { type: ObjectId, required: true, ref: "User" },
    statType: {
      type: String,
      required: true,
      enum: ["call", "chat"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorStatLog", VendorStatLogSchema);

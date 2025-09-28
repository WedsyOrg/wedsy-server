const mongoose = require("mongoose");

const VendorMakeupStyleSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    preferredLook: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorMakeupStyle", VendorMakeupStyleSchema);

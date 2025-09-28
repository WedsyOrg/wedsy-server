const mongoose = require("mongoose");

const VendorAddOnsSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    makeupStyle: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorAddOns", VendorAddOnsSchema);

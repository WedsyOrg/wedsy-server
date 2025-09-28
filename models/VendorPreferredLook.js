const mongoose = require("mongoose");

const VendorPreferredLookSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "VendorPreferredLook",
  VendorPreferredLookSchema
);

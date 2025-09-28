const mongoose = require("mongoose");

const VendorSpecialitySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "VendorSpeciality",
  VendorSpecialitySchema
);

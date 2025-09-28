const mongoose = require("mongoose");

const VendorCategorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorCategory", VendorCategorySchema);

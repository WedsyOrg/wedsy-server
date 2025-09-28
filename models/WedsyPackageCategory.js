const mongoose = require("mongoose");

const WedsyPackageCategorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WedsyPackageCategory", WedsyPackageCategorySchema);

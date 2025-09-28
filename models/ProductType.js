const mongoose = require("mongoose");

const ProductTypeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    info: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProductType", ProductTypeSchema);

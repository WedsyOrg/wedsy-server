const mongoose = require("mongoose");

const QuantitySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Quantity", QuantitySchema);

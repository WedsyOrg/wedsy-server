const mongoose = require("mongoose");

const ColorSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Color", ColorSchema);

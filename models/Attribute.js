const mongoose = require("mongoose");

const AttributeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    list: {
      type: [String],
      required: true,
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attribute", AttributeSchema);

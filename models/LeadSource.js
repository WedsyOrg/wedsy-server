const mongoose = require("mongoose");

const LeadSourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeadSource", LeadSourceSchema);

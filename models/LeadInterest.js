const mongoose = require("mongoose");

const LeadInterestSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeadInterest", LeadInterestSchema);

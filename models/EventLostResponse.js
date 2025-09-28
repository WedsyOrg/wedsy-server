const mongoose = require("mongoose");

const EventLostResponseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EventLostResponse", EventLostResponseSchema);

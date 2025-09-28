const mongoose = require("mongoose");

const EventMandatoryQuestionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    image: { type: String, default: "" },
    description: { type: String, default: "" },
    price: { type: Number, default: 0 },
    itemRequired: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "EventMandatoryQuestion",
  EventMandatoryQuestionSchema
);

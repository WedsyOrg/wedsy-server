const mongoose = require("mongoose");

// Bug 62/63 — declared as an explicit sub-schema because it carries a path
// literally named "type" (mongoose would otherwise read the nested object as
// a type declaration).
const MandatoryConfigSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["note", "options", null], default: null },
    noteMaxLen: { type: Number, default: 0 },
    axes: {
      type: [
        {
          name: { type: String, default: "" },
          options: { type: [String], default: [] },
        },
      ],
      default: [],
    },
    priceMatrix: { type: Object, default: {} },
  },
  { _id: false }
);

const EventMandatoryQuestionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    image: { type: String, default: "" },
    description: { type: String, default: "" },
    price: { type: Number, default: 0 },
    itemRequired: { type: Boolean, default: false },
    // Bug 62/63 — the Mandatory Section structure (additive; legacy questions
    // keep config.type null and behave exactly as before):
    //   "note"    → free-text answer, capped at config.noteMaxLen
    //   "options" → axes (e.g. Size/Duration) + priceMatrix keyed
    //               priceMatrix[axis1Option][axis2Option] → resolved price
    config: { type: MandatoryConfigSchema, default: () => ({}) },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "EventMandatoryQuestion",
  EventMandatoryQuestionSchema
);

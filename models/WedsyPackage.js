const mongoose = require("mongoose");

const WedsyPackageSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    people: {
      type: String,
      required: true,
    },
    time: {
      type: String,
      required: true,
    },
    details: {
      type: String,
      required: true,
    },
    image: {
      type: String,
      required: true,
    },
    process: {
      type: [{ topic: String, description: String }],
      default: [],
    },
    operations: {
      assign: {
        type: String,
        required: true,
      },
      gender: {
        type: String,
        required: true,
      },
      category: {
        type: String,
        required: true,
      },
      number: {
        type: String,
        required: true,
      },
    },
    price: { type: Number, required: true, default: 0 },
    amountToVendor: { type: Number, required: true, default: 0 },
    amountToWedsy: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WedsyPackage", WedsyPackageSchema);

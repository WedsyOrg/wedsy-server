const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const PriceVariationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    variationType: {
      type: String,
      enum: ["Increase", "Decrease"],
    },
    pricingType: {
      type: String,
      enum: ["SellingPrice", "CostPrice"],
    },
    percentage: { type: Number, default: 0, required: true },
    amount: { type: Number, default: 0, required: true },
    decorItems: {
      type: [ObjectId],
      ref: "Decor",
      default: [],
    },
    categories: { type: [String], default: [] },
    status: {
      type: String,
      required: true,
      default: "Pending",
      enum: ["Pending", "Completed", "Reverted"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PriceVariation", PriceVariationSchema);

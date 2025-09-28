const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const DiscountSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      default: "",
    },
    discountPercentage: { type: Number, default: 0, required: true },
    discountAmount: { type: Number, default: 0, required: true },
    decorItems: {
      type: [ObjectId],
      ref: "Decor",
      default: [],
    },
    categories: { type: [String], default: [] },
    status: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Discount", DiscountSchema);

const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const DecorPackageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    variant: {
      artificialFlowers: {
        costPrice: { type: Number, required: true, default: 0 },
        sellingPrice: { type: Number, required: true, default: 0 },
        discount: { type: Number, required: true, default: 0 },
      },
      mixedFlowers: {
        costPrice: { type: Number, required: true, default: 0 },
        sellingPrice: { type: Number, required: true, default: 0 },
        discount: { type: Number, required: true, default: 0 },
      },
      naturalFlowers: {
        costPrice: { type: Number, required: true, default: 0 },
        sellingPrice: { type: Number, required: true, default: 0 },
        discount: { type: Number, required: true, default: 0 },
      },
    },
    included: { type: [String], default: [] },
    decor: { type: [ObjectId], ref: "Decor", default: [] },
    seoTags: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
      image: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DecorPackage", DecorPackageSchema);

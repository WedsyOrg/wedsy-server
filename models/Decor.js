const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const DecorSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: false,
      // enum: ["BestSeller", "Popular", ""],
      default: "",
    },
    rating: { type: Number, default: 0, required: true },
    productVisibility: { type: Boolean, default: false },
    productAvailability: { type: Boolean, default: false },
    spotlight: { type: Boolean, default: false },
    spotlightColor: { type: String, default: "" },
    name: { type: String, required: true },
    unit: { type: String, required: true },
    tags: { type: [String], required: true, default: [] },
    image: { type: String, required: true, default: "" },
    additionalImages: { type: [String], default: [] },
    thumbnail: { type: String, required: true, default: "" },
    video: { type: String, default: "" },
    description: { type: String, default: "" },
    pdf: { type: String, default: "" },
    attributes: { type: [{ name: String, list: [String] }], default: [] },
    productVariation: {
      colors: { type: [String], required: true, default: [] },
      occassion: { type: [String], required: true, default: [] },
      flowers: { type: [String], required: true, default: [] },
      fabric: { type: [String], default: [] },
      style: {
        type: String,
        required: false,
        enum: ["Modern", "Traditional", ""],
        default: "",
      },
      nameboardMaterial: { type: [String], default: [] },
    },
    productInfo: {
      id: { type: String, default: "" },
      measurements: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        area: { type: Number, default: 0 },
        radius: { type: Number, default: 0 },
        other: { type: String, default: "" },
      },
      included: { type: [String], default: [] },
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
      quantity: { type: Number, required: true, default: 1 },
      minimumOrderQuantity: { type: Number, required: true, default: 1 },
      maximumOrderQuantity: { type: Number, required: true, default: 1 },
      SKU: { type: String, default: "" },
    },
    rawMaterials: { type: [{ name: String, quantity: Number }], default: [] },
    seoTags: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
      image: { type: String, default: "" },
    },
    productVariants: {
      type: [
        {
          name: { type: String, default: "" },
          priceModifier: { type: Number, required: true, default: 0 },
          image: { type: String, default: "" },
        },
      ],
      default: [],
    },
    productTypes: {
      type: [
        {
          name: { type: String, default: "" },
          costPrice: { type: Number, required: true, default: 0 },
          sellingPrice: { type: Number, required: true, default: 0 },
          discount: { type: Number, required: false, default: 0 },
        },
      ],
      default: [],
    },
    productAddOns: {
      type: [ObjectId],
      ref: "Decor",
      default: [],
    },
  },
  { timestamps: true }
);

DecorSchema.index({ name: "text", description: "text" });

module.exports = mongoose.model("Decor", DecorSchema);

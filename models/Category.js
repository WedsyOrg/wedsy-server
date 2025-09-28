const mongoose = require("mongoose");

const CategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: -1,
    },
    status: {
      type: Boolean,
      required: true,
      default: false,
    },
    images: {
      squareImage: {
        type: String,
        default: "",
      },
      portaitImage: {
        type: String,
        default: "",
      },
      landscapeImage: {
        type: String,
        default: "",
      },
    },
    attributes: {
      type: [String],
      required: true,
      default: [],
    },
    addOns: {
      type: [String],
      required: true,
      default: [],
    },
    productTypes: {
      type: [String],
      required: true,
      default: [],
    },
    platformAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    flooringAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    multipleAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    adminEventToolView: {
      type: String,
      enum: ["single", "group"],
    },
    websiteView: {
      type: String,
      enum: ["multiple", "single"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", CategorySchema);

const mongoose = require("mongoose");

const AddOnSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    unit: {
      type: String,
      required: true,
    },
    price: {
      type: String,
      required: true,
    },
    image: {
      type: String,
    },
    subAddOns: {
      type: [
        {
          name: {
            type: String,
            required: true,
          },
          price: {
            type: String,
            required: true,
          },
          image: {
            type: String,
            required: true,
          },
        },
      ],
      required: true,
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AddOn", AddOnSchema);

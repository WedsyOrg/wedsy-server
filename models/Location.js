const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const LocationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    locationType: {
      type: String,
      required: true,
      enum: ["State", "City", "Area", "Pincode"],
    },
    parent: {
      type: ObjectId,
      ref: "Location",
      required: false,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Location", LocationSchema);

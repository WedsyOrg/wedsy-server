const mongoose = require("mongoose");

const UserSavedAddressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    place_id: {
      type: String,
    },
    formatted_address: {
      type: String,
    },
    address_components: [
      {
        long_name: String,
        short_name: String,
        types: [String],
      },
    ],
    house_no: {
      type: String,
    },
    city: {
      type: String,
    },
    postal_code: {
      type: String,
    },
    locality: {
      type: String,
    },
    state: {
      type: String,
    },
    country: {
      type: String,
    },
    geometry: {
      location: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },
    address_type: {
      type: String,
      enum: ["home", "work", "billing", "other"],
      default: "home",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserSavedAddress", UserSavedAddressSchema);

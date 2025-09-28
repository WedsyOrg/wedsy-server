const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const WedsyPackageBookingSchema = new mongoose.Schema(
  {
    wedsyPackages: {
      type: [
        {
          package: { type: ObjectId, ref: "WedsyPackage", required: true },
          quantity: { type: Number, required: true, default: 0 },
          price: { type: Number, required: true, default: 0 },
        },
      ],
      default: [],
    },
    address: { type: Object, default: {} },
    date: { type: String, default: "" },
    time: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "WedsyPackageBooking",
  WedsyPackageBookingSchema
);

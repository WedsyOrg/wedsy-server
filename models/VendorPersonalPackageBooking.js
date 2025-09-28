const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VendorPersonalPackageBookingSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: "Vendor", required: true },
    personalPackages: {
      type: [
        {
          package: {
            type: ObjectId,
            ref: "VendorPersonalPackage",
            required: true,
          },
          quantity: { type: Number, required: true, default: 0 },
          price: { type: Number, required: true, default: 0 },
        },
      ],
      default: [],
    },
    address: { type: Object, default: {} },
    date: { type: String, default: "" },
    time: { type: String, default: "" },
    status: {
      accepted: { type: Boolean, default: false },
      rejected: { type: Boolean, default: false },
      completed: { type: Boolean, default: false },
      lost: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "VendorPersonalPackageBooking",
  VendorPersonalPackageBookingSchema
);

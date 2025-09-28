const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const WedsyPackageBookingRequestSchema = new mongoose.Schema(
  {
    wedsyPackageBooking: {
      type: ObjectId,
      ref: "WedsyPackageBooking",
      default: null,
    },
    vendor: { type: ObjectId, ref: "Vendor" },
    status: {
      accepted: { type: Boolean, default: false },
      rejected: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "WedsyPackageBookingRequest",
  WedsyPackageBookingRequestSchema
);

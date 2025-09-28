const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const BiddingBookingSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    vendor: { type: ObjectId, ref: "Vendor", required: true },
    events: { type: [Object] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BiddingBooking", BiddingBookingSchema);

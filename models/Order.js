const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const OrderSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    vendor: { type: ObjectId, ref: "Vendor", default: null },
    source: {
      type: String,
      required: true,
      enum: ["Bidding", "Wedsy-Package", "Personal-Package"],
    },
    biddingBooking: {
      type: ObjectId,
      ref: "BiddingBooking",
      default: null,
    },
    wedsyPackageBooking: {
      type: ObjectId,
      ref: "WedsyPackageBooking",
      default: null,
    },
    vendorPersonalPackageBooking: {
      type: ObjectId,
      ref: "VendorPersonalPackageBooking",
      default: null,
    },
    status: {
      booked: { type: Boolean, default: false },
      finalized: { type: Boolean, default: false },
      paymentDone: { type: Boolean, default: false },
      completed: { type: Boolean, default: false },
      lost: { type: Boolean, default: false },
    },
    amount: {
      total: { type: Number, required: true, default: 0 },
      due: { type: Number, required: true, default: 0 },
      paid: { type: Number, required: true, default: 0 },
      price: { type: Number, required: true, default: 0 },
      cgst: { type: Number, required: true, default: 0 },
      sgst: { type: Number, required: true, default: 0 },
      payableToWedsy: { type: Number, required: true, default: 0 },
      payableToVendor: { type: Number, required: true, default: 0 },
      receivedByWedsy: { type: Number, required: true, default: 0 },
      receivedByVendor: { type: Number, required: true, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", OrderSchema);

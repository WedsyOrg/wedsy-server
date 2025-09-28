const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const BiddingBidSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: "Vendor", required: true },
    bidding: {
      type: ObjectId,
      ref: "Bidding",
      default: null,
    },
    status: {
      accepted: { type: Boolean, default: false },
      rejected: { type: Boolean, default: false },
      userViewed: { type: Boolean, default: false },
      userAccepted: { type: Boolean, default: false },
      userRejected: { type: Boolean, default: false },
    },
    vendor_notes: { type: String, default: false },
    bid: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BiddingBid", BiddingBidSchema);

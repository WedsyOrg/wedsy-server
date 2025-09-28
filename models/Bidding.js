const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const BiddingSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    events: { type: [Object] },
    requirements: {
      city: { type: String, default: "" },
      gender: { type: String, default: "" },
      category: { type: String, default: "" },
    },
    status: {
      active: { type: Boolean, default: true },
      finalized: { type: Boolean, default: false },
      lost: { type: Boolean, default: false },
      completed: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bidding", BiddingSchema);

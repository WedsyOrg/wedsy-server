const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const SettlementSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: "Vendor", required: true },
    amount: { type: Number, required: true, default: 0 },
    amountPaid: { type: Number, required: true, default: 0 },
    amountDue: { type: Number, required: true, default: 0 },
    order: { type: ObjectId, ref: "Order", default: null },
    razporPayId: { type: String, default: "" },
    status: {
      type: String,
      required: true,
      default: "null",
      enum: [
        "null",
        "created",
        "pending",
        "processed",
        "failed",
        "reversed",
        "partially_reversed",
      ],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Settlement", SettlementSchema);

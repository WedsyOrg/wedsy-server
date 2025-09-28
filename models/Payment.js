const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const PaymentSchema = new mongoose.Schema(
  {
    // User (the person doing the payment, or for whom the payment is done.)
    user: { type: ObjectId, ref: "User", required: true },
    // Amount (Total, Paid, Due)
    amount: { type: Number, required: true, default: 0 },
    amountPaid: { type: Number, required: true, default: 0 },
    amountDue: { type: Number, required: true, default: 0 },
    // Payment For? Event or?
    paymentFor: {
      type: String,
      default: "default",
      enum: ["default", "event", "makeup-and-beauty"],
      required: true,
    },
    event: { type: ObjectId, ref: "Event", default: null },
    order: { type: ObjectId, ref: "Order", default: null },
    // Payent Method (Cash, UPI, Bank Transfer [Added by Admin], Razorpay)
    paymentMethod: {
      type: String,
      default: "default",
      enum: ["default", "razporpay", "cash", "upi", "bank-transfer"],
      required: true,
    },
    razporPayId: { type: String, default: "" },
    response: { type: [Object], default: [] },
    // Payment Status: null, created, attempted, paid, partially paid, expired, cancelled
    status: {
      type: String,
      required: true,
      default: "null",
      enum: [
        "null",
        "created",
        "attempted",
        "paid",
        "partially_paid",
        "expired",
        "canceled",
      ],
    },
    transactions: { type: Array, default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", PaymentSchema);

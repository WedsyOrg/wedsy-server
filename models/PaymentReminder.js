const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const PaymentReminderSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    payment: { type: ObjectId, ref: "Payment", required: true },
    event: { type: ObjectId, ref: "Event", required: true },
    eventDay: { type: String, required: true },
    sentBy: { type: ObjectId, ref: "Admin", required: true },
    leadId: { type: ObjectId, ref: "Enquiry", required: false },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentReminder", PaymentReminderSchema);

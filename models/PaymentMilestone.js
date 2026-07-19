const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// L2 — PAYMENT MILESTONE: one row of a lead's payment schedule. Status is
// DERIVED at read time (paid / partial / pending / overdue) from LeadPayment
// rows tagged with this milestone's id — never stored, so it can't drift.
const PaymentMilestoneSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 }, // rupees
    dueAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);
PaymentMilestoneSchema.index({ leadId: 1, sortOrder: 1 });

module.exports =
  mongoose.models.PaymentMilestone || mongoose.model("PaymentMilestone", PaymentMilestoneSchema);

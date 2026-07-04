const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Slice B5a — a MONEY LEDGER row on a lead (the CRM-side record; distinct from
// the consumer-side Payment model, which belongs to the wedsy-user flow).
// Append-only in spirit: creation is owner/manager/lane-owner tier, deletion is
// founder-gated (route: leads:delete:all).
const LeadPaymentSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    projectId: { type: ObjectId, ref: "Project", default: null },
    amount: { type: Number, required: true, min: 0 }, // rupees
    mode: { type: String, enum: ["cash", "bank", "upi", "razorpay"], default: "bank" },
    proofUrl: { type: String, default: "" },
    receivedAt: { type: Date, default: Date.now },
    recordedBy: { type: ObjectId, ref: "Admin", default: null },
    // Assigned once at the FIRST GST-invoice generation (billing.invoicePrefix +
    // the atomically incremented billing.invoiceNextNumber) — then permanent.
    invoiceNumber: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

LeadPaymentSchema.index({ leadId: 1, receivedAt: -1 });

module.exports = mongoose.models.LeadPayment || mongoose.model("LeadPayment", LeadPaymentSchema);

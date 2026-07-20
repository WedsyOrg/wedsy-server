const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// P5 — DEAL DISCOUNT on a draft event. Within the free threshold
// (settings dealDiscount.freePct) it auto-approves; above it, it queues into
// the Approvals machinery (type "discount_approval" on the Team page read).
const DealDiscountSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    eventId: { type: ObjectId, ref: "Event", required: true, index: true },
    amount: { type: Number, default: 0 }, // rupees (resolved at grant time)
    pct: { type: Number, default: 0 }, // the requested percentage (0 = flat amount)
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    givenBy: { type: ObjectId, ref: "Admin", default: null },
    approvedBy: { type: ObjectId, ref: "Admin", default: null },
    at: { type: Date, default: Date.now },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
DealDiscountSchema.index({ eventId: 1, status: 1 });

module.exports = mongoose.models.DealDiscount || mongoose.model("DealDiscount", DealDiscountSchema);

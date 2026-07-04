const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB7a — the onboarding record bridging a CRM lead (Enquiry) and its finalized
// event into the money/agreement flow. One record per {leadId, eventId}.
// Genuinely new state (lock, agreement, milestone payments) — NOT a parallel
// copy of the event finalize/approve machine.
const OnboardingSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    eventId: { type: ObjectId, ref: "Event", default: null },
    startedBy: { type: ObjectId, ref: "Admin", default: null },
    startedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["started", "onboarded", "cancelled"],
      default: "started",
    },
    // CLIENT-side dashboard lock (wedsy-user reads this via the API contract).
    // OS retains full access regardless.
    lockActive: { type: Boolean, default: false },
    // E-sign acceptance (Slice 3).
    agreement: {
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date, default: null },
      acceptedName: { type: String, default: "" },
      agreementVersion: { type: String, default: "" },
    },
    // Milestone snapshot at onboard time (RUPEES) — Slice 4.
    milestones: { type: Object, default: null },
    // ONBOARDED when the onboarding-fee payment lands (Slice 5).
    onboardedAt: { type: Date, default: null },
    onboardingPaymentId: { type: ObjectId, ref: "Payment", default: null },
  },
  { timestamps: true }
);

OnboardingSchema.index({ leadId: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.models.Onboarding || mongoose.model("Onboarding", OnboardingSchema);

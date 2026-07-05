const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB-V2 P3 — the notification mesh table. Cheap trigger emissions (hold /
// forward / claim / onboarding events) land here. Delivery is log-only by
// default (channel "log"); an external channel (WhatsApp/email) can be wired
// later without schema change. Fire-and-forget writers never block the request.
const VenueNotificationSchema = new mongoose.Schema(
  {
    venue: { type: ObjectId, ref: "Venue" }, // absent for pre-venue events (onboarding/new-venue claim)
    type: {
      type: String,
      required: true,
      enum: [
        "hold_requested",
        "lead_forwarded",
        "claim_arrived",
        "onboarding_arrived",
      ],
    },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    channel: { type: String, default: "log" },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date },
  },
  { timestamps: true }
);

VenueNotificationSchema.index({ createdAt: -1 });
VenueNotificationSchema.index({ type: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueNotification ||
  mongoose.model("VenueNotification", VenueNotificationSchema);

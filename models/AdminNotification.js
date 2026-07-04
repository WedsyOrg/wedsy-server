const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// In-OS dashboard notification entries for ADMINS (MB5). The OS notifies staff
// here — no WhatsApp/SMS pings to staff in this build. Surfaced on the
// dashboard bell/strip; read-state per recipient.
const AdminNotificationSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    type: { type: String, required: true }, // e.g. meet_handoff, huddle_due, triage_escalation
    title: { type: String, required: true },
    message: { type: String, default: "" },
    leadId: { type: ObjectId, ref: "Enquiry", default: null },
    payload: { type: Object, default: {} },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

AdminNotificationSchema.index({ adminId: 1, read: 1, createdAt: -1 });

module.exports =
  mongoose.models.AdminNotification ||
  mongoose.model("AdminNotification", AdminNotificationSchema);

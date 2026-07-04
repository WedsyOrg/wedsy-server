const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB7b Slice 1 — internal multi-member chat per lead. Distinct from the
// customer-facing WAConversation: this is the team's back-room thread on a lead.
// System messages (authorId=null, kind="system") narrate task lifecycle (Slice 2).
const AttachmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["image", "pdf"], required: true },
    url: { type: String, required: true },
    name: { type: String, default: "" },
  },
  { _id: false }
);

const LeadChatMessageSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    authorId: { type: ObjectId, ref: "Admin", default: null }, // null = system message
    kind: { type: String, enum: ["message", "system"], default: "message" },
    systemType: { type: String, default: "" }, // task_created | task_completed | nurture_touch | ...
    body: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },
    mentions: { type: [ObjectId], ref: "Admin", default: [] },
    // Per-message read receipts — GET marks the thread read for the caller.
    readBy: { type: [ObjectId], ref: "Admin", default: [] },
    taskId: { type: ObjectId, ref: "LeadTask", default: null },
    // MB8b Slice 3 — set on a mirrored step-note system message; the chat echo
    // links back to the step's notes thread. Additive, default null.
    stepId: { type: ObjectId, ref: "LeadStep", default: null },
    // MB8c-2a-ii — set on a follow-up event card (set / due); the card's
    // Mark-done / Snooze actions act on this follow-up. Additive, default null.
    followupId: { type: ObjectId, ref: "Followup", default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

LeadChatMessageSchema.index({ leadId: 1, createdAt: -1 });

module.exports =
  mongoose.models.LeadChatMessage ||
  mongoose.model("LeadChatMessage", LeadChatMessageSchema);

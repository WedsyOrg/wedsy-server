const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// One row per WhatsApp number talking to the Kiara agent line. The message
// stream stays in WAAgentMessage (keyed by the same raw webhook phone); this
// is the conversation STATE: who owns it (Kiara or a human), whether it's
// screaming for attention, and which CRM lead it belongs to.
//
// phone        — raw Meta webhook phone (message.from, e.g. "91XXXXXXXXXX").
//                Unique: Meta sends a stable form per user, and it's the key
//                WAAgentMessage + the send APIs already use.
// normalizedPhone — last-10-digit form (LeadIntakeService.normalizePhone) for
//                Enquiry cross-referencing/dedup, mirroring the intake engine.
const WAConversationSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    normalizedPhone: { type: String, default: "", index: true },
    enquiryId: { type: ObjectId, ref: "Enquiry", default: null },
    mode: { type: String, enum: ["ai", "human"], default: "ai" },
    needsHuman: { type: Boolean, default: false },
    needsHumanReason: { type: String, default: "" },
    needsHumanAt: { type: Date, default: null },
    classification: {
      type: String,
      enum: ["lead", "vendor", "birthday", "corporate", "destination", null],
      default: null,
    },
    lastInboundAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: "" },
    unreadCount: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "closed"], default: "active" },
  },
  { timestamps: true }
);

WAConversationSchema.index({ needsHuman: -1, lastMessageAt: -1 });
WAConversationSchema.index({ enquiryId: 1 });

module.exports =
  mongoose.models.WAConversation ||
  mongoose.model("WAConversation", WAConversationSchema);

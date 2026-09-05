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
    // MB6 Slice 7: conversation channel. Instagram rows key `phone` by the
    // IG-scoped user id (the same key WAAgentMessage already uses for IG).
    // Default keeps every existing row 'whatsapp' — migration-free.
    channel: { type: String, enum: ["whatsapp", "instagram"], default: "whatsapp" },
    // Display name for the contact. WhatsApp carries it in the webhook
    // (contacts[0].profile.name); Instagram has no name in the message webhook,
    // so it's filled once via a Graph profile fetch (name/username). The inbox
    // shows the linked lead's name first, then this, then the raw id.
    profileName: { type: String, default: "" },
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
    // ── When it closed, and when a customer brought it back ──────────────────
    // Without these, "closed then reopened" is unmeasurable after the fact — and
    // not being able to see that pattern is how 27 threads accumulated 154
    // unanswered customer messages before anyone noticed.
    //
    // closedAt   — stamped by KiaraCrmSyncService when a classification closes it.
    // reopenedAt — stamped by upsertOnInbound when a customer message reopens it.
    //
    // reopenedAt is ALSO load-bearing, not just diagnostic: it is how the
    // classifier knows it has already been contradicted once and must escalate
    // rather than silently close again. See applyExtraction.
    //
    // Together they give the silent interval — how long a customer waited with
    // nobody able to see them.
    closedAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WAConversationSchema.index({ needsHuman: -1, lastMessageAt: -1 });
WAConversationSchema.index({ enquiryId: 1 });

module.exports =
  mongoose.models.WAConversation ||
  mongoose.model("WAConversation", WAConversationSchema);

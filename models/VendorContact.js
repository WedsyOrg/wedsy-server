const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Quiet capture of vendors/suppliers who message the Kiara WhatsApp line.
// No UI yet (a Vendors section comes later) — founder-approved collection so
// "I'll pass your details to our vendor team" is actually true.
const VendorContactSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    name: { type: String, default: "" },
    offering: { type: String, default: "" },
    firstMessage: { type: String, default: "" },
    source: { type: String, default: "whatsapp" },
    conversationId: { type: ObjectId, ref: "WAConversation", default: null },
  },
  { timestamps: true }
);

VendorContactSchema.index({ phone: 1 });

module.exports =
  mongoose.models.VendorContact ||
  mongoose.model("VendorContact", VendorContactSchema);

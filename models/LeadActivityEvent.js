const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// L1 — LEAD ACTIVITY EVENT: the spine of the lead page's Client face. One row
// per couple-side or team-side moment (app login, heart, draft view, quote
// sent, payment, …). Producers: the internal ingest seam (wedsy-user later, a
// shared-secret header) + in-repo hooks (LeadPayment today). Read newest-first
// per lead; "new since I looked" is FE-derived from its own lastViewed — no
// per-admin readAt is stored here.
const KINDS = [
  "login", "heart", "draft_view", "quote_sent", "guest_change", "rsvp",
  "registry", "website_publish", "payment", "task", "circle_change", "other",
];

const LeadActivityEventSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    userId: { type: ObjectId, ref: "User", default: null }, // couple-side actor
    adminId: { type: ObjectId, ref: "Admin", default: null }, // team actor
    kind: { type: String, enum: KINDS, required: true },
    text: { type: String, default: "" }, // the display line
    meta: { type: Object, default: {} },
    voice: { type: String, enum: ["couple", "wedsy"], required: true },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
LeadActivityEventSchema.index({ leadId: 1, at: -1 });
LeadActivityEventSchema.index({ leadId: 1, voice: 1, at: -1 });

module.exports =
  mongoose.models.LeadActivityEvent || mongoose.model("LeadActivityEvent", LeadActivityEventSchema);
module.exports.KINDS = KINDS;

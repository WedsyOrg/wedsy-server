const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VenueConversationSchema = new mongoose.Schema(
  {
    venueId: { type: ObjectId, ref: "Venue", required: true },
    enquiryId: { type: ObjectId, ref: "VenueEnquiry", required: true },
    userId: { type: ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["open", "closed", "archived"],
      default: "open",
    },
    lastMessageAt: { type: Date, default: Date.now },
    unreadCountVenue: { type: Number, default: 0 },
    unreadCountCouple: { type: Number, default: 0 },
    // MB-V2 D4 (additive) — triage routing. `flagged` sticks once any message
    // trips a keyword; `flaggedTerms` accumulates the distinct hits. Cleared by
    // nobody automatically (an admin dismisses in the triage view).
    flagged: { type: Boolean, default: false },
    flaggedTerms: { type: [String], default: [] },
    // Last inbound couple message time — backs the venue-silence SLA metric.
    lastCoupleMessageAt: { type: Date },
  },
  { timestamps: true }
);

VenueConversationSchema.index({ venueId: 1 });
VenueConversationSchema.index({ userId: 1 });
VenueConversationSchema.index({ enquiryId: 1 }, { unique: true });

module.exports =
  mongoose.models.VenueConversation ||
  mongoose.model("VenueConversation", VenueConversationSchema);

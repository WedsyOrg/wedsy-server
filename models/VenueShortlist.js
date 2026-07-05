const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB-V2 P1 — the Lead Planner's venue shortlist, VENUE-OWNED storage (binding
// decision: no CRM models are touched; the CRM lead is referenced by a plain
// string id). One shortlist per CRM enquiry. presentToken is the typed
// credential for the PUBLIC present-mode read; regenerating it invalidates
// every previously shared link.
const ShortlistItemSchema = new mongoose.Schema(
  {
    venue: { type: ObjectId, ref: "Venue", required: true },
    status: {
      type: String,
      enum: ["shortlisted", "presented", "reacted"],
      default: "shortlisted",
    },
    reaction: { type: String, enum: ["", "love", "maybe", "no"], default: "" },
    notes: { type: String, default: "", maxlength: 2000 },
    holdRef: { type: ObjectId, ref: "VenueHold" },
    visitRef: { type: ObjectId, ref: "VenueSiteVisit" },
  },
  { _id: true }
);

const VenueShortlistSchema = new mongoose.Schema(
  {
    crmEnquiryId: { type: String, required: true, trim: true, maxlength: 100 },
    coupleName: { type: String, default: "", trim: true, maxlength: 200 },
    couplePhone: { type: String, default: "", trim: true, maxlength: 20 },
    items: { type: [ShortlistItemSchema], default: [] },
    presentToken: { type: String, index: { unique: true, sparse: true } },
    createdBy: { type: ObjectId, ref: "Admin" },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueShortlistSchema.index({ crmEnquiryId: 1 }, { unique: true });

module.exports =
  mongoose.models.VenueShortlist ||
  mongoose.model("VenueShortlist", VenueShortlistSchema);

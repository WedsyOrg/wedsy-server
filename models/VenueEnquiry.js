const mongoose = require("mongoose");

const VenueEnquirySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },
    email: { type: String, default: "" },
    // eventDate stays the single day the dashboard/calendar/analytics/OS journey
    // read. When checkIn is set it is DERIVED from checkIn (see the pre-validate
    // hook) so every existing consumer keeps working with no changes.
    eventDate: { type: Date },
    // MB-CRM S0b (additive) event window. Optional; when both are set the
    // pre-validate hook enforces checkOut > checkIn and checkOut <= checkIn + 7d.
    checkIn: { type: Date },
    checkOut: { type: Date },
    guestCount: { type: Number },
    budget: { type: String },
    vibe: [{ type: String }],
    message: { type: String, default: "" },
    source: {
      type: String,
      enum: ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "google", "other"],
      default: "wedsy",
    },
    stage: {
      type: String,
      enum: [
        "new",
        "contacted",
        "site_visit_scheduled",
        "site_visit_done",
        "proposal_sent",
        "negotiating",
        "booked",
        "lost",
      ],
      default: "new",
    },
    estimatedValue: { type: Number, default: 0 },
    // Phase 3 (3.x): structured lost reason. "" allowed (legacy/none) so the
    // pre-existing free-text String data never fails validation on save.
    lostReason: {
      type: String,
      enum: ["", "too_expensive", "date_unavailable", "chose_competitor", "no_response", "other"],
      default: "",
    },
    followUpDate: { type: Date },
    // MB-CRM S0e (additive): the note for the CURRENT/next follow-up, shown
    // inline in the Follow-ups view so a rep never calls blind.
    followUpNote: { type: String, default: "" },
    // MB-CRM S0a: assignedTo is now a REAL ref to VenueTeamMember (nullable),
    // the server-side scoped-visibility boundary. Legacy string values ("" or a
    // member _id) hydrate cleanly (Mongoose maps "" -> undefined); the setter
    // coerces any stray "" write to null so we never persist an empty string.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VenueTeamMember",
      default: null,
      set: (v) => (v === "" || v == null ? null : v),
    },
    // MB-V2 P1 (D2, additive): when the Wedsy planner's first venue-touching
    // action creates this owner-visible lead, this carries the CRM lead's id
    // (plain string — the CRM engine is a separate model space).
    crmLeadRef: { type: String, default: "" },
    notes: [{ text: String, addedAt: { type: Date, default: Date.now } }],
    // `via`/`actor` (additive) let assignment audit answer "why is it here?":
    // via = "create_override" | "round_robin" | "manual_reassign" | ...; actor =
    // the VenueTeamMember/VenueOwner id that caused it.
    activities: [
      {
        type: { type: String },
        description: String,
        via: { type: String },
        actor: { type: mongoose.Schema.Types.ObjectId },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ["new", "contacted", "site_visit_scheduled", "negotiating", "booked", "lost"],
      default: "new",
    },
    outreachSentAt: { type: Date },
    outreachChannel: { type: String },
    followUp24hSentAt: { type: Date },
    followUp48hSentAt: { type: Date },
  },
  // id:false avoids adding the duplicate `id` string virtual; virtuals:true so
  // durationHours is serialized by hydrated reads (lean() reads still skip it).
  { timestamps: true, id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// S0b: keep eventDate in sync with the event window and enforce the window
// invariants for EVERY write path (create/update/import/planner) without any
// consumer having to opt in. Runs on validate so a bad window 400s at the
// controller instead of corrupting data.
VenueEnquirySchema.pre("validate", function (next) {
  if (this.checkIn) {
    // Derive the day the rest of the platform reads from checkIn.
    this.eventDate = this.checkIn;
  }
  if (this.checkIn && this.checkOut) {
    if (this.checkOut <= this.checkIn) {
      return next(new Error("checkOut must be after checkIn"));
    }
    if (this.checkOut - this.checkIn > 7 * MS_PER_DAY) {
      return next(new Error("checkOut must be within 7 days of checkIn"));
    }
  }
  next();
});

// S0b: computed event-window length in whole hours (null when the window is
// incomplete). e.g. 24, or 38 for a 1.5-day multi-function block.
VenueEnquirySchema.virtual("durationHours").get(function () {
  if (this.checkIn && this.checkOut) {
    return Math.round((this.checkOut - this.checkIn) / (60 * 60 * 1000));
  }
  return null;
});

VenueEnquirySchema.index({ venueId: 1 });
VenueEnquirySchema.index({ userId: 1 });
VenueEnquirySchema.index({ venueId: 1, stage: 1 });
VenueEnquirySchema.index({ venueId: 1, source: 1 });
// S0a: scoped-visibility query boundary — list/read filtered by assignee.
VenueEnquirySchema.index({ venueId: 1, assignedTo: 1 });

module.exports = mongoose.models.VenueEnquiry || mongoose.model("VenueEnquiry", VenueEnquirySchema);

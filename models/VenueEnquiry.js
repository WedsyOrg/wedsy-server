const mongoose = require("mongoose");
const { venueDateKey } = require("../utils/venueTime");
const { EVENT_TYPES, DEFAULT_EVENT_TYPE, ALL_FUNCTION_NAMES, ALL_RELATIONS } = require("../utils/venueEventType");
const { TRADITIONS } = require("../utils/weddingTraditions");

const VenueEnquirySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    // The lead's display name. DERIVED from the bride/groom contacts when they
    // exist, else the lead name — but it stays a real stored String because
    // ~60 files read it: lists, search, dedup, the header, WhatsApp, PDFs, the
    // couple site, the OS. Turning it into a virtual would have been the tidy
    // change and would have broken every one of them. See
    // utils/venueCoupleName for the derivation and the override.
    coupleName: { type: String, default: "" },
    // TRUE once a human has typed a name here explicitly. The derivation then
    // leaves it alone forever: someone who wrote "The Mehra Wedding" outranks
    // anything we can assemble from contact rows.
    coupleNameManual: { type: Boolean, default: false },
    couplePhone: { type: String, default: "" },
    email: { type: String, default: "" },
    // BUILD A — what KIND of event this is. Defaults to social because that is
    // what these venues sell and what every existing row already is; a
    // different default would silently re-label the entire book. Only the
    // wedding-specific layer keys off this (utils/venueEventType is the whole
    // list) — dates, money, contention, scoping and everything else are shared.
    eventType: { type: String, enum: EVENT_TYPES, default: DEFAULT_EVENT_TYPE },
    // The couple's OWN community calendar — whose panchang says their date is
    // auspicious. Optional and MULTI on purpose: a mixed wedding is two
    // traditions, not a compromise between them, and forcing one would make
    // half the family's dates invisible. Empty means nobody asked, which reads
    // as "applies unless we learn otherwise" — the same convention
    // utils/weddingTraditions.js documents for the date rows themselves.
    // Social leads only in the UI; the model does not enforce that, because a
    // lead retyped as corporate keeps what it was told until a human clears it.
    traditions: {
      type: [{ type: String, enum: TRADITIONS }],
      default: [],
    },
    // eventDate stays the single day the dashboard/calendar/analytics/OS journey
    // read. When checkIn is set it is DERIVED from checkIn (see the pre-validate
    // hook) so every existing consumer keeps working with no changes.
    eventDate: { type: Date },
    // MB-CRM S0b (additive) event window. Optional; when both are set the
    // pre-validate hook enforces checkOut > checkIn and checkOut <= checkIn + 7d.
    checkIn: { type: Date },
    checkOut: { type: Date },
    // BUILD2 S1: "we're marrying in December, day undecided". Until now a lead
    // either had a precise window or nothing at all, so half the enquiries a
    // venue takes on the phone could not be written down as what they are.
    //
    // Defaults TRUE so every existing row keeps its present meaning: a lead
    // with dates is finalised, a lead without is a finalised lead nobody has
    // filled in yet. Only an explicit write makes a lead unfinalised.
    //
    // The two states are mutually exclusive and the pre-validate hook enforces
    // it in BOTH directions — an unfinalised lead has no checkIn/checkOut/
    // eventDate, a finalised one has no approximatePeriod. A row carrying both
    // would make every date consumer pick a winner, and they would not all
    // pick the same one.
    datesFinalised: { type: Boolean, default: true },
    approximatePeriod: {
      // 1-12. Stored as a number rather than a Date so "December 2026" can
      // never be silently read as the 1st of December by a consumer that
      // forgets this is approximate.
      month: { type: Number, min: 1, max: 12, default: null },
      year: { type: Number, min: 2000, max: 2100, default: null },
      // Optional: "some time around the 12th". Never enough to finalise.
      day: { type: Number, min: 1, max: 31, default: null },
    },
    guestCount: { type: Number },
    budget: { type: String },
    vibe: [{ type: String }],
    message: { type: String, default: "" },
    // MB-CRM-2 S1a (additive): structured contacts — who actually decides.
    // coupleName/couplePhone stay the legacy mirrors (dashboards, WhatsApp,
    // dedup import all read them); contacts[] is the CRM-2 source of truth.
    // Exactly one isPrimary is enforced by the controller sanitizer, not here,
    // so legacy rows (empty contacts) never fail validation on save.
    // BUILD A: contacts are now the WHOLE people model. There are deliberately
    // no structured bride/groom fields — a bride is a contact whose relation is
    // `bride`. One model, no special-casing, and it answers "the groom is the
    // one actually calling" for free by letting him be primary.
    contacts: [
      {
        name: { type: String, default: "" },
        phone: { type: String, default: "" },
        email: { type: String, default: "" },
        // Renamed from `role`, and widened per event type
        // (utils/venueEventType.RELATION_VOCABULARY). `role` is kept below as a
        // read-only legacy mirror so any consumer not yet migrated keeps working.
        relation: { type: String, enum: ALL_RELATIONS, default: "other" },
        // Legacy field. Written by the sanitizer, never read by new code.
        // Retained so an un-migrated row and an un-migrated reader both survive
        // the deploy window; scripts/migrate-contact-relations backfills the
        // new field from it.
        role: { type: String, default: "other" },
        // WHO YOU CALL.
        isPrimary: { type: Boolean, default: false },
        // WHO HOLDS THE MONEY — and in Indian weddings that is frequently the
        // bride's father, not either of the people getting married. Knowing it
        // is worth more than the relation labels are, which is why it is its
        // own flag rather than inferred from one.
        isDecisionMaker: { type: Boolean, default: false },
      },
    ],
    // MB-CRM-2 S1b (additive): per-function event mapping across the stay.
    // `space` references a Venue.spaces subdoc _id (same convention as
    // VenueHold.space); it is validated against the venue at the controller
    // (the model can't reach Venue). Two functions may share a date in
    // different spaces — that is normal, never a conflict. Function dates must
    // sit inside [checkIn, checkOut] when the window is set (pre-validate).
    functions: [
      {
        // The UNION of both vocabularies. Which subset is offered is an
        // eventType question the controller answers on WRITE; the model must
        // accept anything already stored, because a lead switched from social
        // to corporate keeps its mehendi row until a human edits it. Silently
        // dropping stored functions on a type change would destroy real data
        // over a mislabelled dropdown.
        name: { type: String, enum: ALL_FUNCTION_NAMES, required: true },
        customLabel: { type: String, default: "" },
        date: { type: Date, required: true },
        timeSlot: { type: String, default: "" },
        space: { type: mongoose.Schema.Types.ObjectId },
        expectedPax: { type: Number },
        notes: { type: String, default: "" },
      },
    ],
    // MB-CRM-2 S1c (additive): "the shape of the deal". All fields optional —
    // "" / undefined mean not-asked-yet, which the UI renders explicitly.
    requirements: {
      food: { type: String, enum: ["", "veg", "nonveg", "both"], default: "" },
      catering: { type: String, enum: ["", "inhouse", "outside", "both"], default: "" },
      alcohol: { type: Boolean },
      roomsNeeded: { type: Number },
      decorNotes: { type: String, default: "" },
      // Anything that does not fit a box. Kept free-text on purpose: "the
      // bride's grandmother uses a wheelchair" and "no beef in the kitchen"
      // are the sentences that lose a booking when they are forgotten, and
      // neither survives being turned into a dropdown.
      specialRequests: { type: String, default: "" },
      /**
       * THE CALL QUESTIONS, AS THEY ARE ACTUALLY ASKED.
       *
       * "Not asked" and "no" are different facts. The old shape could not tell
       * them apart for food, catering and décor — an empty string meant both
       * "nobody has asked" and "they don't want it" — so the checklist could
       * never be finished honestly.
       *
       * Stored in `asks` rather than replacing the scalars above because those
       * hold real values on real leads ("veg", "inhouse") and changing a
       * String field to a subdocument in place would fail to read every
       * existing row. The controller DERIVES `asks` from the legacy scalars
       * when nothing has been answered here yet, so a lead written before this
       * reads correctly with no migration, and there is still exactly one
       * answer on screen.
       */
      asks: {
        food: { answer: { type: String, enum: ["", "yes", "no"], default: "" }, note: { type: String, default: "" } },
        catering: { answer: { type: String, enum: ["", "yes", "no"], default: "" }, note: { type: String, default: "" } },
        alcohol: { answer: { type: String, enum: ["", "yes", "no"], default: "" }, note: { type: String, default: "" } },
        decor: { answer: { type: String, enum: ["", "yes", "no"], default: "" }, note: { type: String, default: "" } },
      },
    },
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
    // BUILD B: the owner closed the pricing advice on THIS lead. Per-lead, not
    // per-user: the advice is about this deal, and once it has been read and
    // acted on it should stop occupying the top of the tab for everyone
    // working the lead. The venue-wide off switch lives on Venue.settings.
    pricingAdviceDismissed: { type: Boolean, default: false },
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
    // MB-CRM S? (review fix): soft-delete. Gated by leads_delete; excluded from
    // every CRM query via utils/venueLeadScope. Never hard-deleted so audit and
    // OS linkage survive.
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId },
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
  // BUILD2 S1: the unfinalised state, enforced for every write path before any
  // window rule runs. Deliberately invalidate() rather than silently coercing:
  // a caller that sends both a window and "dates not finalised" has a bug, and
  // quietly dropping one half would hide it until a date consumer disagreed.
  if (this.datesFinalised === false) {
    const p = this.approximatePeriod || {};
    if (!p.month || !p.year) {
      this.invalidate("approximatePeriod", "approximatePeriod {month, year} is required when dates are not finalised");
    }
    // invalidate() ONLY — deliberately not followed by nulling the field.
    // Re-setting a path clears its pending validation error in Mongoose, so
    // doing both would cancel the refusal out and silently drop a window the
    // caller actually sent. Refusing is the point: a non-controller write path
    // (import, planner, a script) must not be able to store the pair either.
    if (this.checkIn || this.checkOut) {
      this.invalidate("checkIn", "an unfinalised lead cannot carry a check-in/check-out window");
    }
    // eventDate is the field the dashboard, calendar and analytics read. An
    // unfinalised lead has no day, so it carries none — that is what keeps it
    // out of date-keyed views instead of landing on a wrong day. (The 01 Jan
    // 1970 renders came from consumers being handed an empty date, not from a
    // real one.)
    // eventDate is derived here, never caller-authored, so clearing it carries
    // no error to cancel.
    this.eventDate = null;
    // A function is a thing that happens on a DAY. With no window there is no
    // day to hang it on and no window to validate it against, so the pairing is
    // refused outright rather than stored as an unvalidatable date.
    if (Array.isArray(this.functions) && this.functions.length) {
      this.invalidate("functions", "add the dates first — an unfinalised lead cannot have functions");
    }
  } else if (this.approximatePeriod && (this.approximatePeriod.month || this.approximatePeriod.year || this.approximatePeriod.day)) {
    // Finalised leads carry no approximate period. Reverting is legitimate (a
    // couple can un-decide) but it goes through datesFinalised:false, never by
    // leaving a stale month behind on a lead that now has real dates.
    this.approximatePeriod = { month: null, year: null, day: null };
  }

  if (this.checkIn) {
    // Derive the day the rest of the platform reads from checkIn.
    this.eventDate = this.checkIn;
  }
  if (this.checkIn && this.checkOut) {
    // Use invalidate() so save() rejects with a Mongoose ValidationError
    // (err.name === "ValidationError") that controllers surface as 400, not 500.
    if (this.checkOut <= this.checkIn) {
      this.invalidate("checkOut", "checkOut must be after checkIn");
    } else if (this.checkOut - this.checkIn > 7 * MS_PER_DAY) {
      this.invalidate("checkOut", "checkOut must be within 7 days of checkIn");
    }
  }
  // MB-CRM-2 S1b: function dates ⊆ [checkIn, checkOut] whenever the window is
  // set (compared at day granularity — a function on the check-out day is
  // fine). Mirrored by the controller so callers get a clean 400 first; this
  // is the defense-in-depth backstop.
  if (this.checkIn && this.checkOut && Array.isArray(this.functions)) {
    // Compared on the VENUE's calendar day (IST), so the same lead validates
    // identically on a UTC prod box and an IST laptop. setHours() here would
    // make the verdict depend on the server's timezone.
    const lo = venueDateKey(this.checkIn);
    const hi = venueDateKey(this.checkOut);
    for (const fn of this.functions) {
      if (fn && fn.date) {
        const day = venueDateKey(fn.date);
        if (day < lo || day > hi) {
          this.invalidate("functions", "every function date must fall within the check-in/check-out window");
          break;
        }
      }
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
// Soft-delete exclusion is applied to every CRM query.
VenueEnquirySchema.index({ venueId: 1, deleted: 1 });

module.exports = mongoose.models.VenueEnquiry || mongoose.model("VenueEnquiry", VenueEnquirySchema);

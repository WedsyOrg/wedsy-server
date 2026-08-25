const mongoose = require("mongoose");
const { PAYMENT_MODES } = require("../utils/venuePaymentMode");

// Phase 3 (3.1) — a confirmed booking, created (as a draft) when a lead moves to
// "booked". One booking per enquiry (idempotent via the unique sparse index).
const VenueBookingSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" },
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },

    // ── THE EVENT WINDOW ────────────────────────────────────────────────────
    // The same window the lead carries, and the SAME FACT — not a copy that
    // drifts. A lead's dates and its booking's dates are one thing: the window
    // is when the venue is sold, and every day inside it is sold. There is no
    // separate "setup time" or "access period" concept anywhere in this model;
    // if the couple has the venue from 4 PM on the 29th, the 29th is inside the
    // window and the 29th is blocked.
    //
    // Before this existed, confirming a booking DISCARDED the lead's window and
    // kept only days[], so a lead reading "29 Sept → 1 Oct" became a booking
    // reading "30 Sept – 1 Oct" and nothing downstream could recover the
    // difference. utils/venueEventWindow is now the only writer of both copies,
    // and it writes them in the same operation.
    checkIn: { type: Date },
    checkOut: { type: Date },

    // What HAPPENS on each date, inside the window. days[] is the per-date
    // record — the functions, their spaces and their headcount — and it is
    // never what either screen calls "the dates". Dropping a function does not
    // shorten the booking; only the window does that.
    //
    // NOTE spaces here are NAMES, for display. The authoritative space IDs live
    // on the VenueSpaceDate rows keyed by bookingRef, which is what the window
    // machinery reads — see venueEventWindow.bookingSpaceIds.
    days: [
      {
        date: { type: Date },
        eventType: { type: String, default: "" },
        guestCount: { type: Number, default: 0 },
        spaces: [{ type: String }],
      },
    ],
    totalValue: { type: Number, default: 0 },
    // Booking-engine S2/S4 EXTEND this rather than introducing a second model.
    // It already held {label, dueDate, amount}; what was missing is the shape the
    // money came from and whether it has arrived.
    paymentSchedule: [
      {
        label: { type: String, default: "" },
        dueDate: { type: Date },
        amount: { type: Number, default: 0 },
        // S2: the percentage this row represents of the booking value. Stored
        // alongside the amount, not instead of it, because the amount is what
        // the couple owes and must not silently move if the booking value is
        // later corrected — while the percentage is what the owner reasoned in
        // and what the confirmation document shows. Rows written before this
        // slice have no percent, which reads correctly as "amount only".
        percent: { type: Number, min: 0, max: 100, default: null },
        // ── WHAT ARRIVED AGAINST THIS MILESTONE ────────────────────────────
        // A LIST, not a scalar. A milestone is very often paid more than once —
        // a part payment now and the rest next month — and a single paidAmount
        // could only ever remember the total, not who sent what, when, by which
        // method, or against which reference. Every one of those is what an
        // owner needs when a couple disputes what was paid.
        //
        // It is also the only shape in which a payment can be REJECTED and
        // still be visible: with a scalar, un-recording money means subtracting
        // it, and the record that there was ever a claim disappears.
        //
        // paidAmount is DERIVED from these (the sum of the approved ones) by
        // utils/venuePaymentStatus and is never stored — see the note on the
        // legacy field below.
        entries: [
          {
            /**
             * ── WHICH PAYMENT THIS PIECE BELONGS TO ────────────────────────
             * One payment can span two milestones — ₹1,00,000 that finishes
             * Instalment 1 and starts Instalment 2 is TWO entries but ONE
             * thing the couple did, and one thing the bank statement shows.
             * Every entry written by a single recording action shares this id,
             * so the payment can be shown, invoiced (S6) and reversed as the
             * unit it actually is rather than as fragments that happen to
             * share a date.
             */
            paymentId: { type: mongoose.Schema.Types.ObjectId },
            amount: { type: Number, required: true, min: 1 },
            /** When the money actually arrived — not when it was typed in. */
            date: { type: Date, default: Date.now },
            // THE SAME VOCABULARY as the legacy paidMode below and as
            // utils/venuePaymentMode. Deliberately not a fork: two payment
            // method lists in one codebase is how "upi" and "UPI" both end up
            // stored and neither filter finds both.
            method: { type: String, enum: [...PAYMENT_MODES, ""], default: "" },
            /** `other` carries the name the owner typed, as it does above. */
            methodOther: { type: String, default: "" },
            reference: { type: String, default: "" },
            note: { type: String, default: "" },
            /** Optional uploaded proof — a screenshot or a bank slip. */
            proofUrl: { type: String, default: "" },
            /**
             * S3 lands the approval FLOW; the field exists from S1 so that the
             * migration runs once rather than twice. Until then everything is
             * recorded approved, which is exactly today's behaviour.
             */
            status: { type: String, enum: ["pending", "approved", "rejected"], default: "approved" },
            recordedBy: { type: mongoose.Schema.Types.ObjectId },
            recordedByName: { type: String, default: "" },
            approvedBy: { type: mongoose.Schema.Types.ObjectId },
            approvedByName: { type: String, default: "" },
            approvedAt: { type: Date },
            /** Kept on a rejected entry: "why" is the whole value of the record. */
            rejectionReason: { type: String, default: "" },
          },
        ],
        // ── LEGACY, READ-ONLY ──────────────────────────────────────────────
        // Rows written before S1 hold their total here and have no entries. The
        // derivation falls back to this when `entries` is empty, so an
        // un-migrated row still reports the right balance on every surface
        // rather than silently reading as nothing-paid. Nothing writes it any
        // more; the migration converts it into one approved entry.
        //
        // It stays in the schema ON PURPOSE until the migration has been
        // applied everywhere: removing it now would make Mongoose strip the
        // field from any un-migrated document the moment anything saved it,
        // destroying the very number the migration needs to read.
        paidAmount: { type: Number, default: 0, min: 0 },
        paidAt: { type: Date },
        // "other" carries its own name in paidModeOther. Without it, a method
        // outside this list had nowhere to go: the confirm path silently
        // mapped anything unrecognised to "" and the owner's answer was lost.
        paidMode: { type: String, enum: ["bank_transfer", "cash", "cheque", "upi", "card", "other", ""], default: "" },
        /** What the owner called it when they picked "Other". */
        paidModeOther: { type: String, default: "" },
        paidReference: { type: String, default: "" },
        /** Free note against this payment — "paid by the bride's father", etc. */
        paidNote: { type: String, default: "" },
        recordedBy: { type: mongoose.Schema.Types.ObjectId },
        recordedByName: { type: String, default: "" },
        /** Only read under per-instalment GST — see gstMode below. */
        gstApplicable: { type: Boolean, default: false },
        // ── ADDITIONAL BILLING (S5) ────────────────────────────────────────
        // Extras the venue adds after the fact — a bar tab on the night, an
        // extra hour. A row, not a separate list, ON PURPOSE: it then flows
        // through the waterfall, carries payment entries, can be invoiced and
        // shows in the schedule with no second money path. Keeping extras
        // somewhere else is how a booking ends up with two balances.
        //
        // What it changes is the TOTAL, not the agreed value: totalValue stays
        // what was negotiated, and utils/venuePaymentStatus adds these on top.
        isAdditional: { type: Boolean, default: false },
        /** Why this was added — the thing a couple queries three weeks later. */
        addedNote: { type: String, default: "" },
        addedByName: { type: String, default: "" },
      },
    ],
    // ── GST, OUTSIDE THE AGREED VALUE ────────────────────────────────────────
    // totalValue stays what was NEGOTIATED. What the couple transfers is that
    // plus GST, derived per row rather than stored, so the two can never drift.
    //
    // An enum rather than a pair of booleans on purpose: "whole" and
    // "per_instalment" cannot both be in force, so double-taxing is not a state
    // this document can hold.
    gstMode: { type: String, enum: ["none", "whole", "per_instalment"], default: "none" },
    gstPercent: { type: Number, default: 0, min: 0, max: 100 },
    specialRequirements: { type: String, default: "" },
    // Booking→Rooms handoff (product-map dead-end #6, "the Rooms island"): the
    // lead says "we need 20 rooms" and Rooms/PMS never hears about it. Carried
    // onto the booking at creation so the accommodation requirement survives
    // the lead→booking graduation and the PMS can show a real shortfall
    // instead of the owner re-reading the enquiry. Snapshot, not a live join:
    // the reads cross-check the lead so a later change to the requirement is
    // still reflected.
    roomsRequired: { type: Number, default: 0 },
    // MB-CRM-2 S2 (additive): the agreement chosen in the Confirm Booking
    // wizard — a document-engine doc id (generated from template or an
    // attached signed scan). Loose ObjectId on purpose: the docs engine has
    // several doc models and the wizard only needs the pointer.
    agreementDoc: { type: mongoose.Schema.Types.ObjectId },
    status: {
      type: String,
      // ── WHAT THIS ACTUALLY MEANS, AFTER THE AUDIT ────────────────────────
      // Every consumer in the server tests only `cancelled` —
      // venuePayment, venueDashboard, venueOwner, venueAnalytics and
      // venuePricingIntel all query `status: { $ne: "cancelled" }`. NOTHING
      // reads `in_progress` or `completed`: not one query, not one branch.
      // They were write-only values an owner could click, with no behaviour
      // anywhere following.
      //
      // Both are facts about the calendar — the event is happening now, or it
      // has passed — and `days[].date` already holds the answer. So the
      // PRODUCT now derives and states them (utils/venueBookingPhase) rather
      // than offering them as decisions, which stops an owner marking an event
      // "Completed" 35 days early in one click.
      //
      // The enum keeps them, deliberately. PATCH /bookings/:id has always
      // accepted `status` and this repo cannot prove no other client sends
      // them; removing the values would be a breaking change to an API surface
      // for no gain. What changed is what the UI offers, not what the API
      // tolerates.
      enum: ["confirmed", "in_progress", "completed", "cancelled"],
      default: "confirmed",
    },
    /**
     * WHY IT WAS CANCELLED, and when. Cancelling releases every room night and
     * calendar block, which is not something to be able to do without saying
     * why — the reason is the only record of a decision whose effects are
     * otherwise invisible six months later.
     */
    cancellation: {
      reason: { type: String, default: "", maxlength: 2000 },
      at: { type: Date, default: null },
      byName: { type: String, default: "" },
      /** What the cascade actually gave back, recorded at the moment it ran. */
      roomNightsReleased: { type: Number, default: 0 },
      allotmentsCancelled: { type: Number, default: 0 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
    // D6 (additive): archived per-wedding room blocks — the immutable summary
    // of each completed stay. Rooms themselves live on in Venue.rooms.
    roomsHistory: [
      {
        allotment: { type: mongoose.Schema.Types.ObjectId, ref: "VenueRoomAllotment" },
        roomName: { type: String, default: "" },
        guestName: { type: String, default: "" },
        checkInAt: { type: Date },
        checkOutAt: { type: Date },
        guestCount: { type: Number, default: 0 },
        extraBeds: { type: Number, default: 0 },
        damagesTotal: { type: Number, default: 0 },
        deducted: { type: Number, default: 0 },
        refundDue: { type: Number, default: 0 },
        archivedAt: { type: Date },
      },
    ],
  },
  { timestamps: true }
);

VenueBookingSchema.index({ venue: 1, createdAt: -1 });
// One booking per enquiry (sparse: bookings without an enquiry are allowed).
VenueBookingSchema.index({ enquiry: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.VenueBooking || mongoose.model("VenueBooking", VenueBookingSchema);

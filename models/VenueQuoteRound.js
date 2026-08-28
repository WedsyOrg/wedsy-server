const mongoose = require("mongoose");

/**
 * models/VenueQuoteRound.js — one exchange in a price negotiation.
 *
 * ── WHY ITS OWN COLLECTION, NOT A SUBDOCUMENT ───────────────────────────────
 * VenueEnquiry already carries activities[], notes[], contacts[], functions[]
 * and requirements — it is the fattest document in the product and activities
 * alone grows without bound. Rounds are APPEND-HEAVY and carry three free-text
 * fields (terms, reasoning, clientResponse) that people will paste paragraphs
 * into, so putting them inside the lead would push a busy lead toward Mongo's
 * 16MB ceiling on the one document every single CRM read already loads.
 *
 * They are also read as a THREAD — newest first, paginated, sorted, sometimes
 * counted — which wants its own index rather than an in-memory sort of a
 * subarray. This follows the precedent already set in this codebase when
 * follow-ups were moved out of the lead's mirror fields into their own module
 * for exactly these reasons.
 *
 * Scope is not weakened by the split: every read of a round resolves its parent
 * lead through utils/venueLeadScope FIRST, so a round is exactly as private as
 * the lead it belongs to.
 *
 * ── THE ONE-SOURCE-OF-TRUTH RULE ────────────────────────────────────────────
 * These rounds are the NARRATIVE. They are not a second place to look up "what
 * did we quote". The latest round carrying an amount is written through to
 * VenueEnquiry.estimatedValue, which stays the single figure the header,
 * pipeline totals, the day view, the OS projections and the booking path all
 * read — see utils/venueQuotedValue for the write-through and the audit.
 *
 * ── TERMS ARE FREE TEXT ON PURPOSE ──────────────────────────────────────────
 * "+ GST", "inclusive", "+ ₹50k refundable deposit", "includes 200 plates".
 * Every venue prices differently and a schema here would fight the user into
 * mis-stating their own commercial terms. Stored verbatim, searchable, never
 * parsed — nothing in the product tries to compute from this string.
 */
const VenueQuoteRoundSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true },
    // Monotonic per lead, assigned at create. Display only — never used for
    // ordering, because a deleted round must not renumber the ones around it.
    roundNumber: { type: Number, default: 1 },

    // OPTIONAL. A round may legitimately have no amount: "they rang and asked
    // for a discount before we re-quoted" is a real move in the negotiation and
    // losing it would leave a hole in the thread. The controller enforces that
    // a round has an amount OR a client response — a row with neither says
    // nothing happened.
    amount: { type: Number, default: null },

    // Verbatim commercial terms. See the header.
    terms: { type: String, default: "", trim: true },
    // PRIVATE to the venue. Never rendered on a document, never sent anywhere,
    // never included in a payload the couple could reach.
    reasoning: { type: String, default: "", trim: true },

    sentAt: { type: Date },
    sentVia: {
      type: String,
      enum: ["call", "whatsapp", "email", "in_person", "pdf", ""],
      default: "",
    },

    // Their reply, in THEIR words. Free text for the same reason terms is.
    clientResponse: { type: String, default: "", trim: true },
    outcome: {
      type: String,
      enum: ["pending", "accepted", "rejected", "countered", "silent"],
      default: "pending",
    },
    // Only meaningful when outcome is "countered".
    counterAmount: { type: Number, default: null },

    // Optional link to a generated document from the EXISTING quote engine.
    // Most rounds are verbal; never force a PDF to log a phone call.
    quoteRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueQuote" },

    // S4: the terms-and-conditions send, recorded ON the round so the thread
    // shows they were informed — which is the whole point if a dispute follows.
    // The clause text is FROZEN at send time: "which terms did they actually
    // get" cannot be answered by re-reading a template that has since changed.
    termsSentAt: { type: Date },
    termsSentTo: { type: String, default: "" },
    // The DELIVERY verdict, separate from the send record above. `termsSentAt`
    // says the owner sent; these say whether the email actually left — set
    // from what Mailjet returned, never from the fact that we asked it to.
    // A false with a reason is a true statement on a dispute record; a true
    // written before the transport answered would be a lie on one.
    termsDelivered: { type: Boolean, default: false },
    termsDeliveryError: { type: String, default: "" },
    termsDeliveredAt: { type: Date },
    termsMessageId: { type: String, default: "" },
    termsSnapshot: [
      {
        heading: { type: String, default: "" },
        clauses: [String],
      },
    ],
    // When the venue sends its UPLOADED PDF rather than generated clauses, the
    // snapshot is the pointer and the name as sent. The S3 object is never
    // rewritten and is deliberately not deleted when an owner removes the
    // document from Settings, so this link keeps resolving for exactly the
    // dispute that would follow it.
    termsDocument: {
      url: { type: String, default: "" },
      filename: { type: String, default: "" },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// The thread read: newest first for one lead.
VenueQuoteRoundSchema.index({ enquiry: 1, createdAt: -1 });
// Venue-wide reads (pricing comparables ask "what have we been quoting").
VenueQuoteRoundSchema.index({ venue: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueQuoteRound || mongoose.model("VenueQuoteRound", VenueQuoteRoundSchema);

const mongoose = require("mongoose");

/**
 * models/VenueLeadDocument.js — every document generated for a lead, kept
 * forever, never rewritten.
 *
 * ── WHY A NEW COLLECTION ────────────────────────────────────────────────────
 * Nothing existing can hold this. VenueContract is booking-scoped and requires
 * a `booking`, but these go out mid-negotiation before any booking exists —
 * loosening that model would weaken a guarantee other code relies on.
 * VenueDocumentTemplate is a venue-level preset, not an instance. The T&C send
 * currently records a frozen snapshot on VenueQuoteRound, which is exactly right
 * for "were they informed", but a quote round is not a filing cabinet: a lead can
 * have three generated documents against one round, and the round holds one
 * `termsDocument` pointer.
 *
 * Subdocuments on VenueEnquiry were rejected for the reason
 * models/VenueFollowUp.js sets out: the lead list is read unpaginated, so an
 * unbounded history array is dragged into every list response forever.
 *
 * ── IMMUTABILITY IS THE WHOLE POINT ─────────────────────────────────────────
 * This is an audit trail for documents sent to a customer during a negotiation
 * that may end in a dispute. "Which document did they actually receive" must be
 * answerable years later, so:
 *
 *   · Each generation is a NEW ROW with the next `version` for that lead.
 *   · Rows are never updated after insert. There is no edit path, and the
 *     pre-save hook below refuses any modification of an existing row outright
 *     rather than trusting every future caller to remember.
 *   · The stored S3 object is never overwritten — keys carry a unique segment,
 *     so v1's bytes stay v1's bytes when v2 is made.
 *   · Superseding is implicit in the version number, not a mutation. There is
 *     deliberately no `isLatest` flag: a flag has to be flipped on the old row,
 *     which is the exact write this model exists to forbid. "Latest" is
 *     max(version), derived on read.
 *
 * Nothing here is soft-deleted either, matching the venue child collections
 * beside it (QuoteRound, FollowUp, SiteVisit). A generated document that was
 * sent cannot be un-sent.
 *
 * Scope is not weakened by the split: every read resolves the parent lead
 * through utils/venueLeadScope FIRST, so a document is exactly as private as the
 * lead it belongs to (404, never 403).
 */
const VenueLeadDocumentSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    // `enquiry` rather than `lead`, to match VenueQuoteRound — the model this
    // sits beside and is read alongside. (The repo is inconsistent: FollowUp
    // says `lead`, SiteVisit says `enquiryRef`. Matching the neighbour wins.)
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true },

    // What kind of document. Only terms exists today; the enum is here so the
    // Documents tab does not have to change shape when agreements or proposals
    // join it.
    // Booking-engine S3/S5 extend this enum. The Documents tab is kind-agnostic
    // by design (#130), so adding a kind needs no tab change — only a generator.
    //   terms                 the T&C cover stitched onto the venue's PDF (#130)
    //   booking_confirmation  generated from the booking (S3)
    //   invoice               generated from the booking + a payment (S5)
    //   statement             the whole booking's account on one page — agreed
    //                         value, every additional billing line, everything
    //                         received, and the balance. NOT an invoice for one
    //                         payment: the answer to "send me the total bill".
    //
    // ── VENUE DOCS vs CLIENT DOCS ────────────────────────────────────────────
    // The kinds above are things WE generate and send. `address_proof` and
    // `client_document` are things the CLIENT gives US, and they are kinds on
    // this same model rather than a second collection — the versioning, the
    // immutability, the lead scoping and the "which one did we actually have"
    // question are identical whichever direction the paper travelled. A second
    // model would have meant re-earning all four.
    //
    // The Documents tab splits them on `origin` (derived below), not on a
    // hand-maintained list, so a new kind lands on the correct side of the tab
    // by declaring itself rather than by someone remembering to update a UI.
    kind: {
      type: String,
      enum: ["terms", "booking_confirmation", "invoice", "statement", "address_proof", "client_document"],
      default: "terms",
      required: true,
    },

    // ── CLIENT DOCUMENTS ONLY ────────────────────────────────────────────────
    // Which identity document this is — the owner picks from a list, and
    // "other" carries the name they gave it. Empty for anything we generated.
    proofType: {
      type: String,
      enum: ["driving_licence", "aadhaar", "pan", "passport", "other", ""],
      default: "",
    },
    proofTypeOther: { type: String, default: "", maxlength: 120 },
    /** Which contact this proof belongs to, when the owner said. */
    contactName: { type: String, default: "", maxlength: 200 },
    /** Who uploaded it (client docs) as opposed to who generated it. */
    uploadedByName: { type: String, default: "" },

    // Per-lead, 1-based, gapless. Assigned by the controller under a retry on
    // the unique index below, so two simultaneous generations cannot collide.
    version: { type: Number, required: true, min: 1 },

    // ── THE SEND NOTE ────────────────────────────────────────────────────────
    // Free text the operator types at generation, e.g.
    // "v2 — removed the outside-décor restriction". This is what makes three
    // near-identical PDFs legible six weeks later; without it the list is three
    // rows of the same filename and different timestamps, which answers nothing.
    // Optional, because forcing a note produces "asdf" rather than meaning.
    note: { type: String, default: "", maxlength: 2000 },

    // ── the stitched artefact ────────────────────────────────────────────────
    url: { type: String, default: "" },
    filename: { type: String, default: "" },
    sizeBytes: { type: Number },
    contentType: { type: String, default: "application/pdf" },
    pageCount: { type: Number },
    coverPages: { type: Number },
    sourcePages: { type: Number },

    // ── provenance of what went INTO it ─────────────────────────────────────
    // The venue's uploaded PDF as it stood at generation time. Kept because the
    // owner may replace or delete the source in Settings afterwards, and the
    // question "what were they sent" must not depend on what Settings holds
    // today. The S3 object behind sourceUrl is deliberately never deleted.
    source: {
      url: { type: String, default: "" },
      filename: { type: String, default: "" },
      sizeBytes: { type: Number },
    },
    // Snapshot of the personalisation, so the cover can be explained without
    // re-reading a lead that has since moved on.
    cover: {
      coupleName: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      eventDates: [{ type: Date }],
      quotedAmount: { type: Number },
    },
    // Asserted at generation: the source's per-page content streams survived
    // the stitch unchanged. Stored rather than merely checked so the claim is
    // auditable later, not just true at the moment nobody was looking.
    sourceVerified: { type: Boolean, default: false },
    sourceVerifiedPages: { type: Number },

    // Who generated it. Name as well as id, because the id stops resolving the
    // day that member leaves and "generated by someone who no longer works
    // here" is still useful provenance — same reasoning as
    // Venue.termsDocument.uploadedByName.
    generatedBy: { type: mongoose.Schema.Types.ObjectId },
    generatedByName: { type: String, default: "" },

    // The quote round this generation was recorded against, so the Documents tab
    // and the money thread can be reconciled.
    quoteRound: { type: mongoose.Schema.Types.ObjectId, ref: "VenueQuoteRound" },
  },
  { timestamps: true }
);

// The immutability guarantee, enforced rather than documented. Any attempt to
// save an already-persisted row is refused — a new version is the only way to
// change anything.
VenueLeadDocumentSchema.pre("save", function refuseMutation(next) {
  if (!this.isNew) {
    return next(
      new Error(
        "VenueLeadDocument rows are immutable — generate a new version instead of editing version " +
          this.version
      )
    );
  }
  return next();
});

/**
 * WHICH SIDE OF THE DOCUMENTS TAB A KIND BELONGS TO.
 *
 * Derived from the kind rather than stored, so it cannot disagree with it, and
 * exported so the controller and the tests read the same definition instead of
 * each keeping a list that drifts.
 */
const CLIENT_KINDS = ["address_proof", "client_document"];
const originOfKind = (kind) => (CLIENT_KINDS.includes(kind) ? "client" : "venue");

// Newest-first read for the Documents tab, and the max(version) lookup.
VenueLeadDocumentSchema.index({ enquiry: 1, kind: 1, version: -1 });
// Venue-wide listing / counts.
VenueLeadDocumentSchema.index({ venue: 1, createdAt: -1 });
// Makes the version sequence a database guarantee rather than a hope: two
// concurrent generations cannot both claim v2.
VenueLeadDocumentSchema.index({ enquiry: 1, kind: 1, version: 1 }, { unique: true });

const VenueLeadDocument =
  mongoose.models.VenueLeadDocument || mongoose.model("VenueLeadDocument", VenueLeadDocumentSchema);

module.exports = VenueLeadDocument;
module.exports.CLIENT_KINDS = CLIENT_KINDS;
module.exports.originOfKind = originOfKind;

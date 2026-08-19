const mongoose = require("mongoose");

// Phase 3 (3.3) — a GST invoice generated from a booking. invoiceNumber is a
// per-venue auto-incrementing string (prefix + zero-padded seq) assigned at
// creation and immutable thereafter.
const VenueInvoiceSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    invoiceNumber: { type: String, required: true },
    seq: { type: Number, required: true }, // per-venue sequence backing invoiceNumber
    kind: { type: String, enum: ["advance", "final", "addon"], default: "advance" },
    lineItems: [
      {
        label: { type: String, default: "" },
        category: { type: String, default: "other" },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
        perDay: { type: Boolean, default: false },
        day: { type: Number, default: null },
      },
    ],
    gstPercent: { type: Number, default: 18 },
    // D8 (additive): how GST was applied. Pre-existing invoices read as
    // "exclusive" — exactly the math they were created with.
    gstMode: { type: String, enum: ["exclusive", "inclusive", "none"], default: "exclusive" },
    // E3x white-label: true → PDF renders venue-branding-only (small
    // "Powered by Wedsy" footer, no system line). Defaults per venue setting;
    // bill conversion carries the bill's flag.
    whiteLabel: { type: Boolean, default: false },
    discount: { type: Number, default: 0 },
    totals: {
      subtotal: { type: Number, default: 0 },
      taxable: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    // D8 (additive): T&C stamped from template/policyDoc + acceptance log.
    terms: [String],
    acceptance: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      at: { type: Date },
      channel: { type: String, enum: ["link", "whatsapp", ""], default: "" },
    },
    // Set when this invoice was converted from a bill (D8 bill-before-invoice).
    billRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBill" },
    status: {
      type: String,
      enum: ["unpaid", "partially_paid", "paid"],
      default: "unpaid",
    },
    payments: [
      {
        date: { type: Date, default: Date.now },
        amount: { type: Number, default: 0 },
        mode: { type: String, enum: ["bank_transfer", "cash", "cheque", "upi", "card"], default: "bank_transfer" },
        note: { type: String, default: "" },
        // D7 payments approval (all additive). Who recorded it, who physically
        // collected, optional proof upload. Pre-existing entries have no
        // status field and default to "approved" — exactly their old meaning.
        recordedByType: { type: String, enum: ["owner", "member", ""], default: "" },
        recordedById: { type: mongoose.Schema.Types.ObjectId },
        recordedByName: { type: String, default: "" },
        collectedBy: { type: String, default: "" },
        proofUrl: { type: String, default: "" },
        status: { type: String, enum: ["pending_approval", "approved", "rejected"], default: "approved" },
        // Permanent "Owner entry" label (D7: owner-recorded auto-approves).
        ownerEntry: { type: Boolean, default: false },
        approvedByName: { type: String, default: "" },
        approvedAt: { type: Date },
        rejectedReason: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

// Booking-engine S5 (additive): the lead this invoice belongs to, so the
// Documents tab can list invoices without going through the booking. Denormalised
// rather than joined because every read of the tab needs it and the booking↔lead
// link is immutable once set.
VenueInvoiceSchema.add({
  enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" },
  // The VenueLeadDocument row holding the rendered PDF, so download and version
  // history come from the same infrastructure as every other lead document.
  leadDocument: { type: mongoose.Schema.Types.ObjectId, ref: "VenueLeadDocument" },
  // Set when this invoice was raised against ONE recorded payment (S5: "one at
  // booking, then one per recorded payment"). The subdocument id of the
  // VenueBooking.paymentSchedule row, or null for the at-booking invoice.
  forMilestoneId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

/**
 * ── IMMUTABILITY, SCOPED TO WHAT "IMMUTABLE" CAN MEAN HERE ──────────────────
 * S5 requires an invoice to be immutable once generated. That cannot mean the
 * whole document is frozen: `payments` and `status` are mutated by four existing
 * flows (venueInvoice.addPayment/approvePayment/rejectPayment, venueCheckin),
 * and a tax invoice legitimately accumulates payments against it over time.
 *
 * What must never change is the FINANCIAL CONTENT — the number it was issued
 * under, the sequence backing it, what was charged, and how tax was applied.
 * Those are what a customer holds a copy of and what a tax authority would
 * compare against. So the guard freezes exactly those paths and leaves payment
 * application alone, which is both the correct semantics and the only version
 * that does not break code already in production.
 */
const FROZEN_PATHS = [
  "invoiceNumber",
  "seq",
  "venue",
  "booking",
  "enquiry",
  "lineItems",
  "gstPercent",
  "gstMode",
  "discount",
  "totals",
  "kind",
  "forMilestoneId",
];

VenueInvoiceSchema.pre("save", function freezeFinancials(next) {
  if (this.isNew) return next();
  const touched = FROZEN_PATHS.filter((p) => this.isModified(p));
  if (touched.length) {
    return next(
      new Error(
        `Invoice ${this.invoiceNumber} is immutable once generated — cannot change ${touched.join(", ")}. ` +
          "Raise a new invoice instead."
      )
    );
  }
  return next();
});

VenueInvoiceSchema.index({ venue: 1, createdAt: -1 });
VenueInvoiceSchema.index({ booking: 1 });
// Booking-engine S5: the Documents tab's read.
VenueInvoiceSchema.index({ enquiry: 1, createdAt: -1 });
// Unique invoice number per venue.
VenueInvoiceSchema.index({ venue: 1, invoiceNumber: 1 }, { unique: true });

// ── ONE INVOICE PER MILESTONE, ENFORCED BY THE DATABASE ─────────────────────
// controllers/venueLeadInvoice checks for an existing invoice before raising
// one, but a read-then-write cannot stop two members pressing the button at the
// same moment: both reads miss, both writes succeed, and the lead ends up with
// two immutable tax invoices covering one instalment. Neither can be deleted.
// So the check stays as the friendly path and THIS is the guarantee.
//
// PARTIAL, NOT SPARSE. `forMilestoneId` carries `default: null`, so it is
// present on every document; a sparse compound index indexes a document when
// ANY of its keys is present, which would pull in every createFromBooking /
// checkin / bill-conversion invoice as {missing, null} and collide them with
// each other — several invoices per booking is legitimate on those paths. The
// partial filter says what is actually meant: only invoices raised against a
// LEAD are one-per-milestone. Those are exactly the ones that set `enquiry`.
//
// Within that filter, {enquiry, null} is also unique, which is the same rule
// the controller's check applies: one booking-level invoice per lead.
VenueInvoiceSchema.index(
  { enquiry: 1, forMilestoneId: 1 },
  { unique: true, partialFilterExpression: { enquiry: { $type: "objectId" } } }
);

module.exports = mongoose.models.VenueInvoice || mongoose.model("VenueInvoice", VenueInvoiceSchema);

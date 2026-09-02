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
        // ── PER-ROW TAX FACTS (document system) ───────────────────────────
        // Filled at creation from the SAME derivation that builds totals
        // (gstOnRow per payment piece; lineTaxable/lineGst per quoted line),
        // so the tax-invoice layout can print taxable/CGST/SGST per row
        // without re-deriving. Absent on invoices raised before this field
        // existed — those rows render an em dash and the totals still hold.
        taxable: { type: Number, default: null },
        gst: { type: Number, default: null },
        perDay: { type: Boolean, default: false },
        day: { type: Number, default: null },
      },
    ],
    gstPercent: { type: Number, default: 18 },
    // D8 (additive): how GST was applied. Pre-existing invoices read as
    // "exclusive" — exactly the math they were created with.
    gstMode: { type: String, enum: ["exclusive", "inclusive", "none"], default: "exclusive" },

    // ── WHO THIS WAS BILLED TO, FROZEN ───────────────────────────────────────
    // A SNAPSHOT, taken when the invoice is raised, and never a live join to
    // the lead's contacts[]. An issued tax invoice is a financial record: if
    // someone corrects a client's GSTIN or phone in People next month, the
    // invoice that already went out must keep saying what it said. Reading the
    // contact live would silently rewrite history — and for the GSTIN
    // specifically, would change the number a client filed their input tax
    // credit against.
    //
    // contacts[] remains the one source for who the client IS. This is what we
    // told them at the moment we billed them.
    billedTo: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      /** The CLIENT's GSTIN. The venue's own lives on Venue.gstin. */
      gstin: { type: String, default: "" },
    },
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
  // ── S6: AN INVOICE KEYS ON THE PAYMENT ──────────────────────────────────────
  // A Rs. 1,00,000 payment that finishes one instalment and starts the next
  // belongs to NEITHER of them. Keying on the milestone forced that payment to
  // be filed against whichever one somebody picked, which made the invoice
  // disagree with the bank statement it is supposed to evidence.
  //
  // forMilestoneId is kept, not replaced: invoices raised before S6 are keyed
  // that way and are immutable tax records. Both live in one index below.
  forPaymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
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

/** One sentence, whichever door the write came through. */
function frozenMessage(label, touched) {
  return (
    `Invoice ${label || "(unidentified)"} is immutable once generated — cannot change ${touched.join(", ")}. ` +
    "Raise a new invoice instead."
  );
}

VenueInvoiceSchema.pre("save", function freezeFinancials(next) {
  if (this.isNew) return next();
  const touched = FROZEN_PATHS.filter((p) => this.isModified(p));
  if (touched.length) return next(new Error(frozenMessage(this.invoiceNumber, touched)));
  return next();
});

// ── THE SAME RULE FOR QUERY WRITES ──────────────────────────────────────────
// pre("save") is DOCUMENT middleware. It does not run for updateOne,
// findOneAndUpdate or any other query write, so until this existed the whole
// immutability guarantee could be stepped around by writing the update through
// a query instead of a document — proven in review by setting invoiceNumber to
// "HACKED-0001" and grandTotal to 1 with a single updateOne. This branch's own
// controllers/venueLeadInvoice used updateOne, so that was not a hypothetical
// path: it was the path already in use.
//
// WHY MIDDLEWARE RATHER THAN ROUTING THAT ONE CALL SITE THROUGH .save():
// converting the call site fixes today's single instance and leaves the hole
// open. The next person to reach for updateOne — reasonably, since it is the
// cheaper write and leadDocument is not frozen — reopens it silently, and
// nothing fails to tell them. Middleware makes the model the thing that
// refuses, so the guarantee holds for writers that do not exist yet. The
// existing updateOne is then free to stay as it is, because it only touches
// leadDocument; it is now covered rather than trusted.
const FROZEN_ROOTS = new Set(FROZEN_PATHS);
const UPDATE_OPERATORS = new Set([
  "$set", "$unset", "$setOnInsert", "$inc", "$mul", "$min", "$max", "$rename",
  "$push", "$pull", "$pullAll", "$pop", "$addToSet", "$bit",
]);

/** Root field of a possibly-dotted, possibly-positional path: totals.gst -> totals */
const rootOf = (path) => String(path).split(".")[0];

/**
 * Every frozen root an update document would touch.
 * Covers operator form ({$set:{"totals.gst":1}}), replacement form
 * ({totals:{…}}), and $rename's destination as well as its source.
 */
function frozenPathsInUpdate(update) {
  if (!update || typeof update !== "object") return [];
  const hit = new Set();
  for (const [key, value] of Object.entries(update)) {
    if (UPDATE_OPERATORS.has(key)) {
      if (!value || typeof value !== "object") continue;
      for (const [path, target] of Object.entries(value)) {
        if (FROZEN_ROOTS.has(rootOf(path))) hit.add(rootOf(path));
        // $rename moves a field TO a name; landing on a frozen one counts.
        if (key === "$rename" && FROZEN_ROOTS.has(rootOf(target))) hit.add(rootOf(target));
      }
    } else if (!key.startsWith("$")) {
      // Replacement-style update: { totals: {...} } or { "totals.gst": 1 }.
      if (FROZEN_ROOTS.has(rootOf(key))) hit.add(rootOf(key));
    }
  }
  return [...hit];
}

function guardQueryWrite(next) {
  // An upsert that inserts is a creation, not a mutation — but nothing in this
  // codebase upserts invoices (allocateInvoice is the one creation path), so
  // rather than guess at insert-vs-update we refuse frozen paths either way and
  // keep the rule single-sentence: after creation, these fields do not change.
  const touched = frozenPathsInUpdate(this.getUpdate());
  if (touched.length) {
    const filter = this.getFilter ? this.getFilter() : {};
    const label = filter && filter.invoiceNumber ? filter.invoiceNumber : filter && filter._id ? String(filter._id) : "";
    return next(new Error(frozenMessage(label, touched)));
  }
  return next();
}

// replaceOne is included deliberately: replacing a document is the most
// complete way to change a frozen field.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  VenueInvoiceSchema.pre(op, guardQueryWrite);
}

// Model.bulkWrite bypasses query middleware entirely — it is not a Query, so
// none of the hooks above see it. Mongoose 7 has no pre("bulkWrite") either:
// registering one is accepted silently and never fires, which is how this was
// found (the hook "passed" while seq changed to 31337 underneath it). So the
// static itself is wrapped. bulkWrite is unused for invoices today; this makes
// that stay true rather than depending on it.
VenueInvoiceSchema.statics.bulkWrite = function guardedBulkWrite(ops, ...rest) {
  for (const op of ops || []) {
    const body = (op && (op.updateOne || op.updateMany || op.replaceOne)) || null;
    if (!body) continue;
    const touched = frozenPathsInUpdate(body.update || body.replacement);
    if (touched.length) return Promise.reject(new Error(frozenMessage("", touched)));
  }
  return mongoose.Model.bulkWrite.call(this, ops, ...rest);
};

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
//
// ── S6: THE SAME GUARANTEE, EXTENDED TO PAYMENTS ────────────────────────────
// The key gains forPaymentId. THREE rules now hold, all on this one index and
// all enforced by the database rather than by a read-then-write:
//
//   { enquiry, null,        null      }  one booking-level invoice per lead
//   { enquiry, milestoneId, null      }  legacy: one per milestone (pre-S6)
//   { enquiry, null,        paymentId }  one per payment (S6)
//
// Adding a third key CANNOT introduce a collision among existing documents:
// none of them has forPaymentId, Mongo indexes a missing field as null, and
// {e, m} pairs that were already unique stay unique as {e, m, null}.
//
// It does REMOVE one: a payment-keyed invoice {e, null, p} and the booking-level
// invoice {e, null, null} collided under the old two-key index because both
// read as {e, null}. That is precisely the pair S6 needs to coexist, which is
// why the old index must be DROPPED rather than left alongside — see
// scripts/migrate-invoice-payment-index.js. Until it is dropped, raising a
// payment invoice on a lead that already has a booking-level one will 409.
VenueInvoiceSchema.index(
  { enquiry: 1, forMilestoneId: 1, forPaymentId: 1 },
  { unique: true, partialFilterExpression: { enquiry: { $type: "objectId" } } }
);

module.exports = mongoose.models.VenueInvoice || mongoose.model("VenueInvoice", VenueInvoiceSchema);

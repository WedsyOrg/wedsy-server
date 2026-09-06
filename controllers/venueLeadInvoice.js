/**
 * controllers/venueLeadInvoice.js — S5c: raise an invoice from the lead.
 *
 * "One at booking, then one per recorded payment. Generated from the booking and
 * the payment, never re-entered."
 *
 * ── WHAT IS REUSED, AND WHY NOTHING IS REBUILT ──────────────────────────────
 *   numbering   controllers/venueInvoice.allocateInvoice — an atomic
 *               VenueCounter $inc lazy-seeded from max(seq), with a bounded
 *               retry. Verified gapless under 12 concurrent allocations
 *               (tests/venue-invoice-guarantees). A second numbering path is
 *               exactly what this brief forbids.
 *   tax maths   utils/venueMoney.computeTotals — already handles
 *               exclusive/inclusive/none, so "GST optional per invoice" is a
 *               mode argument, not new arithmetic.
 *   branding    utils/venueBranding — one resolved answer for every document.
 *   the artefact  utils/venueInvoicePdf + the #130 VenueLeadDocument row, so an
 *               invoice appears in the SAME Documents tab, with the same
 *               versioning, notes, immutability and download path as the T&Cs.
 *
 * ── THE ONE NEW RULE: NO ACCIDENTAL DUPLICATE ───────────────────────────────
 * An invoice is immutable and consumes a number, so generating the same one
 * twice — a double-clicked button — leaves a permanent second tax document that
 * cannot be edited away. So a second invoice for the same (booking, milestone)
 * is refused with 409 and the existing number, rather than silently allocated.
 *
 * TWO LAYERS, AND ONLY ONE OF THEM IS A GUARANTEE. The findOne check below is
 * the friendly path: it produces the good message on the overwhelmingly common
 * double-click. It cannot stop two members pressing Raise in the same instant —
 * both reads miss, both writes proceed — so the real rule is the unique index
 * {enquiry, forMilestoneId} on models/VenueInvoice, and the 11000 it raises is
 * translated back into the same 409. Read-then-write alone let two immutable
 * tax invoices cover one instalment; that was a review finding, not a theory.
 *
 * The rule is scoped by `enquiry`, which is deliberate: invoices created by the
 * older venue-level path (controllers/venueInvoice.createFromBooking) have no
 * `enquiry` field, and several may legitimately exist for one booking. The index
 * carries a matching partial filter, so the new rule cannot retroactively block
 * anything that already works.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
const { computeTotals, invoiceViewOfLines } = require("../utils/venueMoney");
const { resolveBranding, BRANDING_SELECT } = require("../utils/venueBranding");
const { billedToSnapshot } = require("../utils/venueBilledTo");
const { buildInvoicePdf } = require("../utils/venueInvoicePdf");
const { uploadBufferToS3 } = require("../utils/s3Upload");
const { allocateInvoice, isMilestoneCollision } = require("./venueInvoice");
const { insertNextVersion } = require("./venueLeadDocument");

const DEFAULT_GST_PERCENT = 18;
const MAX_NOTE = 2000;

/** Venue + lead, scoped. A miss is 404, never 403 — existence is not leaked. */
async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(BRANDING_SELECT).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) { res.status(404).json({ message: "Lead not found" }); return null; }
  return { venue, lead };
}

const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;
async function actorName(req) {
  if (req.admin) return "Wedsy admin";
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    return (m && m.name) || "team member";
  }
  return o.name || "Owner";
}

const present = (inv) => ({
  _id: inv._id,
  invoiceNumber: inv.invoiceNumber,
  seq: inv.seq,
  gstMode: inv.gstMode,
  gstPercent: inv.gstPercent,
  totals: inv.totals,
  forMilestoneId: inv.forMilestoneId || null,
  /** Set when this invoice was raised against a PAYMENT rather than a plan row. */
  forPaymentId: inv.forPaymentId || null,
  /** GST-first: which half of a split payment this covers — "taxed",
   *  "untaxed", or null on invoices raised outside that model. */
  stream: inv.stream || null,
  leadDocument: inv.leadDocument || null,
  createdAt: inv.createdAt,
});

// ── GET /venues/:slug/enquiries/:enquiryId/invoices ─────────────────────────
const listLeadInvoices = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const invoices = await VenueInvoice.find({ enquiry: lead._id }).sort({ seq: -1 }).lean();
    const booking = await VenueBooking.findOne({ enquiry: lead._id }).select("totalValue paymentSchedule").lean();
    const brand = resolveBranding(venue);
    return res.status(200).json({
      invoices: invoices.map(present),
      // The UI needs to know whether GST can even be offered before showing the
      // choice — "optional" must not mean "offer it with no GSTIN to put on it".
      canChargeGst: brand.hasGstin,
      gstin: brand.gstin,
      defaultGstPercent: DEFAULT_GST_PERCENT,
      bookingValue: booking ? Number(booking.totalValue) || 0 : 0,
      hasBooking: Boolean(booking),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/invoices ────────────────────────
// Body: { gst?: boolean, gstMode?: "exclusive"|"inclusive", gstPercent?: number,
//         milestoneId?: <paymentSchedule subdoc id>, note?: string }

/**
 * ── GST-FIRST: ONE PAYMENT, UP TO TWO INVOICES ──────────────────────────────
 * Founder ruling (wizard2). On a booking whose schedule includes the GST,
 * every payment fills the TAXED stream first (each line's taxable base plus
 * its GST), then the UNTAXED stream (everything else, deposits included) —
 * always, not a setting. Each payment produces:
 *
 *   · a TAX invoice for what landed on the taxed stream — the amount is
 *     grossed down at the booking's one rate (a Rs. 5,000 payment against an
 *     18% stream invoices taxable 4,237 + GST 763), because a part payment
 *     issues a PART tax invoice: the money arrived and the supply happened.
 *   · an ORDINARY invoice for the rest — no GSTIN block, no tax columns.
 *
 * WHERE THE STREAM POSITION COMES FROM: the tax invoices themselves. What
 * this payment puts on the taxed stream is the stream minus what tax
 * invoices already cover — never a re-walk of payment history — so
 * out-of-order approvals can never double-tax a rupee: the ledger of issued
 * documents IS the position. The payment that CLOSES the stream derives its
 * taxable/GST by subtraction from the lines' own totals, so the issued tax
 * invoices sum EXACTLY to the lines' taxable and GST, never a rupee off.
 *
 * One number each from the same gapless allocator; each half is raisable
 * exactly once ({enquiry, null, paymentId, stream} unique).
 */
async function createGstFirstSplitInvoices({ req, res, venue, lead, booking, paymentPieces, forPaymentId, body }) {
  const { computeLineTotals, lineStreams } = require("../utils/venueMoney");
  const totalsAll = computeLineTotals(booking.lineItems, booking.gstPercent);
  const streams = lineStreams(totalsAll);
  const pct = Number(booking.gstPercent) || 0;
  const amount = paymentPieces.reduce((sum, x) => sum + (Math.round(Number(x.entry.amount)) || 0), 0);
  const pieceLabels = [...new Set(paymentPieces.map((x) => x.row.label || "Instalment"))].join(" + ");
  if (amount <= 0) {
    return res.status(400).json({ message: "That payment has no amount to invoice.", code: "nothing_to_invoice" });
  }

  // the ledger: what the taxed stream already has documents for
  const coveredAgg = await VenueInvoice.aggregate([
    { $match: { enquiry: lead._id, stream: "taxed" } },
    { $group: { _id: null, grand: { $sum: "$totals.grandTotal" }, taxable: { $sum: "$totals.taxable" } } },
  ]);
  const taxedCovered = coveredAgg.length ? Math.round(coveredAgg[0].grand) : 0;
  const taxableCovered = coveredAgg.length ? Math.round(coveredAgg[0].taxable) : 0;

  // ── WHAT THIS PAYMENT STILL NEEDS DOCUMENTS FOR ─────────────────────────
  // The stream position must be computed ONCE per payment. A re-raise cannot
  // re-derive it from the (now further advanced) ledger — that is how a
  // Rs. 5,000 payment whose tax invoice already stands would grow a second,
  // ordinary Rs. 5,000: the same money documented twice. So any existing
  // invoice for this payment fixes what remains: covered in full → 409; a
  // half-raised split (a crash between the two allocations) → only the
  // missing remainder is raised, never a recomputation of the whole.
  const existing = await VenueInvoice.find({ enquiry: lead._id, forMilestoneId: null, forPaymentId })
    .select("invoiceNumber stream totals _id").lean();
  const legacySingle = existing.find((i) => !i.stream);
  if (legacySingle) {
    return res.status(409).json({
      message: `${legacySingle.invoiceNumber} already covers that payment.`,
      code: "invoice_exists", invoiceNumber: legacySingle.invoiceNumber, invoiceId: legacySingle._id,
    });
  }
  const taxedExisting = existing.find((i) => i.stream === "taxed");
  const untaxedExisting = existing.find((i) => i.stream === "untaxed");
  const coveredForPayment = existing.reduce((sum, i) => sum + Math.round((i.totals && i.totals.grandTotal) || 0), 0);
  if (coveredForPayment >= amount) {
    const names = existing.map((i) => i.invoiceNumber).join(" and ");
    return res.status(409).json({
      message: `${names || "An invoice"} already cover${existing.length === 1 ? "s" : ""} that payment.`,
      code: "invoice_exists",
      invoiceNumber: existing[0] && existing[0].invoiceNumber,
      invoiceId: existing[0] && existing[0]._id,
    });
  }
  let taxedHere;
  let untaxedHere;
  if (taxedExisting || untaxedExisting) {
    // resume the half-raised split: the remainder goes to the missing half
    const remainder = amount - coveredForPayment;
    if (taxedExisting) { taxedHere = 0; untaxedHere = remainder; }
    else { taxedHere = Math.max(0, Math.min(remainder, streams.taxed - taxedCovered)); untaxedHere = remainder - taxedHere; }
  } else {
    taxedHere = Math.max(0, Math.min(amount, streams.taxed - taxedCovered));
    untaxedHere = amount - taxedHere;
  }
  const wantTaxed = taxedHere > 0 && !taxedExisting;
  const wantUntaxed = untaxedHere > 0 && !untaxedExisting;
  if (!wantTaxed && !wantUntaxed) {
    const names = existing.map((i) => i.invoiceNumber).join(" and ");
    return res.status(409).json({
      message: `${names || "An invoice"} already cover${existing.length === 1 ? "s" : ""} that payment.`,
      code: "invoice_exists",
      invoiceNumber: existing[0] && existing[0].invoiceNumber,
      invoiceId: existing[0] && existing[0]._id,
    });
  }

  const brand = resolveBranding(venue);
  if (wantTaxed && !brand.hasGstin) {
    return res.status(400).json({
      message: "This payment lands on the taxed stream, but no GSTIN is set. Add it in Settings → Billing & tax.",
      code: "no_gstin",
    });
  }

  const billedTo = billedToSnapshot(lead.contacts, booking);
  const closesStream = taxedCovered + taxedHere === streams.taxed;
  const raised = [];
  try {
    if (wantTaxed) {
      // gross down at the one rate; the closing payment reconciles by
      // subtraction so the stream's documents sum exactly to the lines
      const taxable = closesStream
        ? totalsAll.taxable - taxableCovered
        : Math.round((taxedHere * 100) / (100 + pct));
      const gst = taxedHere - taxable;
      const inv = await allocateInvoice(venue, {
        booking: booking._id, enquiry: lead._id,
        forMilestoneId: null, forPaymentId, stream: "taxed",
        kind: "final",
        lineItems: [{ label: `Payment received — ${pieceLabels}`, category: "payment", qty: 1, unitPrice: taxable, taxable, gst }],
        gstPercent: pct, gstMode: "exclusive", discount: 0,
        totals: { subtotal: taxable, taxable, gst, grandTotal: taxedHere },
        whiteLabel: brand.whiteLabel, billedTo,
      });
      raised.push(inv);
    }
    if (wantUntaxed) {
      const inv = await allocateInvoice(venue, {
        booking: booking._id, enquiry: lead._id,
        forMilestoneId: null, forPaymentId, stream: "untaxed",
        kind: "final",
        lineItems: [{ label: `Payment received — ${pieceLabels}`, category: "payment", qty: 1, unitPrice: untaxedHere, taxable: 0, gst: 0 }],
        gstPercent: 0, gstMode: "none", discount: 0,
        totals: { subtotal: untaxedHere, taxable: 0, gst: 0, grandTotal: untaxedHere },
        whiteLabel: brand.whiteLabel, billedTo,
      });
      raised.push(inv);
    }
  } catch (e) {
    if (!isMilestoneCollision(e)) throw e;
    const winner = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId: null, forPaymentId })
      .select("invoiceNumber _id").lean();
    return res.status(409).json({
      message: winner ? `${winner.invoiceNumber} already covers that payment.` : "An invoice for that payment was raised a moment ago.",
      code: "invoice_exists",
      invoiceNumber: winner ? winner.invoiceNumber : undefined,
      invoiceId: winner ? winner._id : undefined,
    });
  }

  // render + file each half in the Documents tab; the invoice rows are the
  // tax records and survive a failed render exactly as on the single path
  const docs = [];
  const note = cleanStr(body.note).slice(0, MAX_NOTE);
  for (const inv of raised) {
    let rendered;
    try {
      const { buildVenueDocument } = require("../utils/docsystem");
      const { loadLogoBuffer } = require("../utils/venuePdf");
      const logoBuffer = await loadLogoBuffer(resolveBranding(venue).logo);
      rendered = await buildVenueDocument("invoice", { venue, lead, booking, invoice: inv, logoBuffer });
    } catch (e) {
      console.error(`[venueLeadInvoice] render failed for ${inv.invoiceNumber}: ${e.message}`);
      return res.status(500).json({
        message: `Invoice ${inv.invoiceNumber} was recorded but its PDF could not be produced. Please report this.`,
        code: "render_failed", invoiceNumber: inv.invoiceNumber,
      });
    }
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let url;
    try {
      url = await uploadBufferToS3({
        buffer: rendered.buffer,
        key: `venues/${venue._id}/invoices/${stamp}.pdf`,
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error(`[venueLeadInvoice] S3 upload failed for ${inv.invoiceNumber}: ${e.message}`);
      return res.status(502).json({
        message: `Invoice ${inv.invoiceNumber} was recorded but could not be stored. Please report this.`,
        code: "storage_failed", invoiceNumber: inv.invoiceNumber,
      });
    }
    const doc = await insertNextVersion(
      {
        venue: venue._id, enquiry: lead._id, kind: "invoice",
        note: note || (inv.stream === "taxed"
          ? `${inv.invoiceNumber} (tax invoice — GST ${pct}%)`
          : `${inv.invoiceNumber} (no GST)`),
        url, sizeBytes: rendered.buffer.length, contentType: "application/pdf",
        source: { url: "", filename: "", sizeBytes: null }, sourceVerified: false,
        generatedBy: actorId(req), generatedByName: await actorName(req),
      },
      () => ({ filename: `invoice-${inv.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, "")}.pdf` })
    );
    await VenueInvoice.updateOne({ _id: inv._id }, { $set: { leadDocument: doc._id } });
    inv.leadDocument = doc._id;
    docs.push(doc);
  }

  lead.activities.push({
    type: "invoice_raised",
    description:
      raised.length === 2
        ? `Invoices ${raised[0].invoiceNumber} (tax) and ${raised[1].invoiceNumber} raised for a payment of ${amount} — taxed stream ${taxedHere}, untaxed ${untaxedHere}`
        : `Invoice ${raised[0].invoiceNumber}${raised[0].stream === "taxed" ? " (tax)" : " (no GST)"} raised for a payment of ${amount}`,
    actor: actorId(req),
    timestamp: new Date(),
  });
  await lead.save();

  return res.status(201).json({
    success: true,
    invoice: present(raised[0]),
    document: docs[0] ? { _id: docs[0]._id, version: docs[0].version, filename: docs[0].filename, note: docs[0].note } : null,
    ...(raised[1] ? { secondInvoice: present(raised[1]) } : {}),
    ...(docs[1] ? { secondDocument: { _id: docs[1]._id, version: docs[1].version, filename: docs[1].filename, note: docs[1].note } } : {}),
    split: {
      payment: amount,
      taxed: taxedHere,
      untaxed: untaxedHere,
      taxedStream: streams.taxed,
      taxedCoveredBefore: taxedCovered,
      streamClosed: closesStream,
    },
    downloadPath: docs[0] ? `/venues/${venue.slug}/enquiries/${lead._id}/documents/${docs[0]._id}/download` : undefined,
  });
}

const createLeadInvoice = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) {
      return res.status(400).json({
        message: "This lead has no confirmed booking yet — confirm the booking first, then raise an invoice.",
        code: "no_booking",
      });
    }

    // ── WHICH INVOICE IS THIS ────────────────────────────────────────────────
    // Three shapes, and the key differs for each:
    //   · a PAYMENT      → { enquiry, null, paymentId }   (S6, the normal case)
    //   · a MILESTONE    → { enquiry, milestoneId, null } (legacy callers)
    //   · the whole booking → { enquiry, null, null }
    //
    // A payment that spanned two instalments belongs to neither of them, which
    // is the whole reason the key moved. Its entries are gathered across every
    // row they landed on.
    let milestone = null;
    let paymentPieces = [];
    let forPaymentId = null;

    if (body.paymentId) {
      if (!mongoose.isValidObjectId(body.paymentId)) {
        return res.status(400).json({ message: "paymentId is not valid" });
      }
      for (const row of booking.paymentSchedule || []) {
        for (const e of row.entries || []) {
          if (e.paymentId && String(e.paymentId) === String(body.paymentId)) paymentPieces.push({ row, entry: e });
        }
      }
      if (!paymentPieces.length) {
        return res.status(404).json({ message: "That payment is not on this booking" });
      }
      // Only APPROVED money is invoiceable. A tax invoice for a payment that is
      // still awaiting approval — or was rejected — is a document asserting
      // money arrived when the venue has not accepted that it did.
      const live = paymentPieces.filter((x) => (x.entry.status || "approved") === "approved");
      if (!live.length) {
        const st = paymentPieces[0].entry.status;
        return res.status(409).json({
          message: st === "pending"
            ? "That payment is still awaiting approval — approve it before invoicing it."
            : "That payment was rejected, so there is nothing to invoice.",
          code: st === "pending" ? "payment_pending" : "payment_rejected",
        });
      }
      paymentPieces = live;
      forPaymentId = new mongoose.Types.ObjectId(String(body.paymentId));
      // ── GST-FIRST: the split path owns payment invoices on new-model
      // bookings. Everything below (the instalment-decides derivation, the
      // single-invoice key) is the OLD model and keeps serving old bookings.
      if (booking.scheduleIncludesGst) {
        return createGstFirstSplitInvoices({ req, res, venue, lead, booking, paymentPieces, forPaymentId, body });
      }
    } else if (body.milestoneId) {
      if (!mongoose.isValidObjectId(body.milestoneId)) {
        return res.status(400).json({ message: "milestoneId is not valid" });
      }
      milestone = (booking.paymentSchedule || []).id
        ? booking.paymentSchedule.id(body.milestoneId)
        : (booking.paymentSchedule || []).find((m) => String(m._id) === String(body.milestoneId));
      if (!milestone) return res.status(404).json({ message: "That milestone is not on this booking" });
    }
    const forMilestoneId = milestone ? milestone._id : null;

    // No accidental duplicate — an invoice is immutable and consumes a number.
    // The friendly path only; the unique index is the guarantee (see below).
    const existing = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId, forPaymentId }).select("invoiceNumber _id").lean();
    if (existing) {
      return res.status(409).json({
        message: forPaymentId
          ? `${existing.invoiceNumber} already covers that payment.`
          : milestone
            ? `${existing.invoiceNumber} already covers that instalment.`
            : `${existing.invoiceNumber} is already this booking's invoice.`,
        code: "invoice_exists",
        invoiceNumber: existing.invoiceNumber,
        invoiceId: existing._id,
      });
    }

    const brand = resolveBranding(venue);

    // ── line items come off the booking, never re-entered ──────────────────
    //
    // For a PAYMENT, one line per instalment the money landed on, each at the
    // amount that actually landed there — not the instalment's face value. A
    // Rs. 1,00,000 payment that finished a Rs. 1,50,000 instalment invoices the
    // Rs. 1,00,000 received, because an invoice evidences money, not a plan.
    //
    // The row's KIND is read from its own flags — `isAdditional` — and never
    // inferred from which of amount/percent happens to be populated. Both are
    // populated on a normal percentage row, and reading that pair as a signal
    // is precisely the mistake that broke the wizard in S4.
    // The BOOKING-LEVEL invoice on a line booking bills the booking's own
    // lines — non-refundable only, with per-line GST — instead of fabricating
    // one "Venue booking" line from the scalar. The held deposit is not on it:
    // see invoiceViewOfLines for why held money is never on a tax invoice.
    const lineView = !paymentPieces.length && !milestone && (booking.lineItems || []).length
      ? invoiceViewOfLines(booking.lineItems, booking.gstPercent)
      : null;
    const lineItems = paymentPieces.length
      ? paymentPieces.map((x) => ({
          label:
            `${x.row.label || "Instalment"}${x.row.isAdditional ? " (additional)" : ""}` +
            ` — ${booking.coupleName || "booking"}`,
          category: x.row.isAdditional ? "extra" : "instalment",
          qty: 1,
          unitPrice: Math.round(Number(x.entry.amount) || 0),
        }))
      : milestone
        ? [{
            label:
              `${milestone.label || "Instalment"}${milestone.isAdditional ? " (additional)" : ""}` +
              ` — ${booking.coupleName || "booking"}`,
            category: milestone.isAdditional ? "extra" : "instalment",
            qty: 1,
            unitPrice: Math.round(Number(milestone.amount) || 0),
          }]
        : lineView
          ? lineView.lineItems
          : [{
              label: `Venue booking — ${booking.coupleName || "booking"}`,
              category: "venue",
              qty: 1,
              unitPrice: Math.round(Number(booking.totalValue) || 0),
            }];
    if (!lineItems.reduce((sum, li) => sum + li.unitPrice, 0)) {
      return res.status(400).json({
        message: forPaymentId
          ? "That payment has no amount to invoice."
          : milestone
            ? "That instalment has no amount yet — set the schedule before invoicing it."
            : "This booking has no value yet — set it before raising an invoice.",
        code: "nothing_to_invoice",
      });
    }

    // ── GST: THE INSTALMENT DECIDES, NOT THE OWNER, ON A PAYMENT INVOICE ────
    // S4 put the GST treatment on the booking (mode + rate) and, under
    // per-instalment mode, on the row. A tax invoice must reflect what was
    // agreed, not what somebody ticked when raising it — so for a payment
    // invoice the GST is DERIVED from the rows the money landed on, using the
    // same gstOnRow the schedule and the wizard use.
    //
    // A payment spanning a GST-bearing instalment AND a plain one is taxed per
    // line: computeTotals applies one rate to the whole subtotal, which would
    // over-tax the plain half. So the payment case computes its own totals from
    // the same arithmetic rather than approximating with a blended rate.
    let derivedGst = null;
    if (paymentPieces.length) {
      const { gstOnRow } = require("../utils/venuePaymentSchedule");
      const bookingGstMode = booking.gstMode || "none";
      const bookingGstPercent = Number(booking.gstPercent) || 0;
      let taxable = 0;
      let gstTotal = 0;
      paymentPieces.forEach((x, i) => {
        const g = gstOnRow(lineItems[i].unitPrice, {
          gstMode: bookingGstMode,
          gstPercent: bookingGstPercent,
          // Read explicitly off the row, never inferred.
          rowApplicable: Boolean(x.row.gstApplicable),
        });
        if (g.bears) {
          taxable += lineItems[i].unitPrice;
          gstTotal += g.gst;
        }
        // the row keeps its own facts — the document prints, never re-derives
        lineItems[i].taxable = g.bears ? lineItems[i].unitPrice : 0;
        lineItems[i].gst = g.bears ? g.gst : 0;
      });
      const subtotal = lineItems.reduce((sum, li) => sum + li.unitPrice, 0);
      derivedGst = {
        bears: gstTotal > 0,
        gstPercent: bookingGstPercent,
        totals: { subtotal, discount: 0, taxable, gst: gstTotal, grandTotal: subtotal + gstTotal },
      };
      if (derivedGst.bears && !brand.hasGstin) {
        return res.status(400).json({
          message: "This payment covers a GST-bearing instalment, but no GSTIN is set. Add it in Settings → Billing & tax.",
          code: "no_gstin",
        });
      }
    } else if (lineView) {
      // Same rule as the payment invoice, one level up: the AGREEMENT decides
      // the GST, not the owner's checkbox. A line booking's tax was settled
      // line by line when the quote was accepted, so body.gst / body.gstMode /
      // body.gstPercent are ignored here exactly as they are on a payment
      // invoice — a tax invoice reflects what was agreed, not what somebody
      // ticked when raising it.
      derivedGst = {
        bears: lineView.bears,
        gstPercent: lineView.gstPercent,
        totals: { ...lineView.totals, discount: 0 },
      };
      if (derivedGst.bears && !brand.hasGstin) {
        return res.status(400).json({
          message: "This booking's lines bear GST, but no GSTIN is set. Add it in Settings → Billing & tax.",
          code: "no_gstin",
        });
      }
    }

    const wantsGst = derivedGst ? derivedGst.bears : (body.gst === true || body.gst === "true");
    if (wantsGst && !brand.hasGstin) {
      return res.status(400).json({
        message: "Add your GSTIN in Settings → Billing & tax before raising a GST invoice.",
        code: "no_gstin",
      });
    }
    const gstMode = derivedGst
      // Always exclusive on a payment invoice: S4's GST sits OUTSIDE the agreed
      // value, so it is added on top, never carved out of it.
      ? (derivedGst.bears ? "exclusive" : "none")
      : wantsGst ? (body.gstMode === "inclusive" ? "inclusive" : "exclusive") : "none";
    const gstPercent = derivedGst
      ? (derivedGst.bears ? derivedGst.gstPercent : 0)
      : wantsGst
        ? Number.isFinite(Number(body.gstPercent)) ? Number(body.gstPercent) : DEFAULT_GST_PERCENT
        : 0;

    // Existing arithmetic, including gstMode "none" — except on a payment
    // invoice, where GST was already worked out per line above.
    const totals = derivedGst ? derivedGst.totals : computeTotals(lineItems, gstPercent, 0, gstMode);

    // ── the number, via the ONE existing allocator ─────────────────────────
    // The check above is the friendly path; the {enquiry, forMilestoneId} unique
    // index is the guarantee. Two members pressing Raise at the same moment both
    // pass the check — only one of them gets past this write.
    let invoice;
    try {
      invoice = await allocateInvoice(venue, {
        booking: booking._id,
        enquiry: lead._id,
        forMilestoneId,
        forPaymentId,
        kind: forPaymentId || milestone ? "final" : "advance",
        lineItems,
        gstPercent,
        gstMode,
        discount: 0,
        totals,
        whiteLabel: brand.whiteLabel,
        // Frozen at the moment of raising — see the model on why this is a
        // snapshot and not a live read of contacts[].
        billedTo: billedToSnapshot(lead.contacts, booking),
      });
    } catch (e) {
      if (!isMilestoneCollision(e)) throw e;
      // The winner's row is already committed — name it, so the loser sees the
      // same 409 the friendly path would have given rather than a 500.
      const winner = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId, forPaymentId })
        .select("invoiceNumber _id")
        .lean();
      return res.status(409).json({
        message: winner
          ? milestone
            ? `${winner.invoiceNumber} already covers that instalment.`
            : `${winner.invoiceNumber} is already this booking's invoice.`
          : "An invoice for that instalment was raised a moment ago.",
        code: "invoice_exists",
        invoiceNumber: winner ? winner.invoiceNumber : undefined,
        invoiceId: winner ? winner._id : undefined,
      });
    }

    // ── render, store, and file it in the Documents tab ────────────────────
    let rendered;
    try {
      // For a payment invoice the "payment" the PDF describes is the first row
      // the money landed on — the document itself lists every line.
      const { buildVenueDocument } = require("../utils/docsystem");
      const { loadLogoBuffer } = require("../utils/venuePdf");
      const logoBuffer = await loadLogoBuffer(resolveBranding(venue).logo);
      rendered = await buildVenueDocument("invoice", { venue, lead, booking, invoice, logoBuffer });
    } catch (e) {
      // The invoice row exists and has consumed its number; that is correct —
      // the tax record is the thing that matters and the PDF can be re-rendered.
      console.error(`[venueLeadInvoice] render failed for ${invoice.invoiceNumber}: ${e.message}`);
      return res.status(500).json({
        message: `Invoice ${invoice.invoiceNumber} was recorded but its PDF could not be produced. Please report this.`,
        code: "render_failed",
        invoiceNumber: invoice.invoiceNumber,
      });
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `invoice-${invoice.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, "")}.pdf`;
    let url;
    try {
      url = await uploadBufferToS3({
        buffer: rendered.buffer,
        key: `venues/${venue._id}/invoices/${stamp}.pdf`,
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error(`[venueLeadInvoice] S3 upload failed for ${invoice.invoiceNumber}: ${e.message}`);
      return res.status(502).json({
        message: `Invoice ${invoice.invoiceNumber} was recorded but could not be stored. Please report this.`,
        code: "storage_failed",
        invoiceNumber: invoice.invoiceNumber,
      });
    }

    const note = cleanStr(body.note).slice(0, MAX_NOTE);
    const generatedByName = await actorName(req);
    const doc = await insertNextVersion(
      {
        venue: venue._id,
        enquiry: lead._id,
        kind: "invoice",
        note: note || `${invoice.invoiceNumber}${gstMode === "none" ? " (no GST)" : ` (GST ${gstPercent}%)`}`,
        url,
        sizeBytes: rendered.buffer.length,
        contentType: "application/pdf",
        pageCount: rendered.tableStats ? undefined : undefined,
        source: { url: "", filename: "", sizeBytes: null },
        sourceVerified: false,
        generatedBy: actorId(req),
        generatedByName,
      },
      () => ({ filename })
    );

    // The link back, written with updateOne so the invoice's own immutability
    // guard is not tripped — leadDocument is not a frozen path, but updateOne
    // also avoids re-validating a document we do not intend to change otherwise.
    await VenueInvoice.updateOne({ _id: invoice._id }, { $set: { leadDocument: doc._id } });
    invoice.leadDocument = doc._id;

    lead.activities.push({
      type: "invoice_raised",
      description: `Invoice ${invoice.invoiceNumber} raised${gstMode === "none" ? " (no GST)" : ` with GST ${gstPercent}%`}${milestone ? ` for ${milestone.label || "an instalment"}` : ""}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(201).json({
      success: true,
      invoice: present(invoice),
      document: { _id: doc._id, version: doc.version, filename: doc.filename, note: doc.note },
      downloadPath: `/venues/${venue.slug}/enquiries/${lead._id}/documents/${doc._id}/download`,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listLeadInvoices, createLeadInvoice, present, DEFAULT_GST_PERCENT };

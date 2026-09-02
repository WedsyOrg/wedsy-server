/**
 * controllers/venueLeadStatement.js — the STATEMENT OF ACCOUNT.
 *
 * "Send me the total bill." One document for the WHOLE booking: the agreed
 * value, every additional billing line itemised, the total, everything
 * received, and the balance. Not an invoice for one payment.
 *
 * ── WHAT IS REUSED, AND WHY NOTHING IS REBUILT ──────────────────────────────
 *   the money    utils/venuePaymentStatus.summarizeSchedule — Build B's single
 *                source. This controller does not sum a payment, does not
 *                decide what "received" means, and does not compute a balance.
 *   the artefact utils/venueStatementPdf, built from the same venuePdf /
 *                venueBranding / documentDate / venueDocTable primitives as the
 *                invoice, so page breaks and over-long cells behave identically.
 *   the filing   the #130 VenueLeadDocument row, so a statement lands in the
 *                SAME Documents tab with the same versioning, notes,
 *                immutability and download path as everything else.
 *
 * ── WHY THERE IS NO DUPLICATE GUARD ─────────────────────────────────────────
 * An invoice refuses a second copy for the same milestone because it is a tax
 * document that consumes a gapless number, and two of them for one instalment
 * is a permanent problem. A statement is neither: it consumes no number, and
 * generating one on Tuesday and another on Friday is the NORMAL use — the
 * balance has moved. Each is a new version, and the version history is the
 * point rather than something to suppress.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
const { BRANDING_SELECT } = require("../utils/venueBranding");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { computeLineTotals } = require("../utils/venueMoney");
const { buildStatementPdf } = require("../utils/venueStatementPdf");
const { uploadBufferToS3 } = require("../utils/s3Upload");
const { insertNextVersion } = require("./venueLeadDocument");

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

/**
 * Everything the statement needs, gathered once.
 *
 * PREVIEW AND GENERATE CALL THIS SAME FUNCTION. The preview an owner reads
 * before pressing the button and the numbers that land in the PDF come from one
 * computation, so the preview cannot promise what the document then contradicts.
 */
async function gatherStatement(venue, lead) {
  const booking = await VenueBooking.findOne({ enquiry: lead._id, venue: venue._id }).sort({ createdAt: -1 });
  if (!booking) return { error: "This lead has no booking yet, so there is nothing to state." };
  const summary = summarizeSchedule(booking);
  const invoices = await VenueInvoice.find({ enquiry: lead._id, venue: venue._id })
    .select("invoiceNumber totals gstMode gstPercent createdAt forMilestoneId forPaymentId")
    .sort({ createdAt: 1 })
    .lean();
  return { booking, summary, invoices };
}

/** What the statement WOULD say, without writing anything. */
function previewOf({ booking, summary, invoices }) {
  const totals = summary.totals || {};
  const rows = summary.rows || [];
  const gstMode = booking.gstMode || "none";
  const gstPercent = Number(booking.gstPercent) || 0;
  const gstOn = gstMode !== "none" && gstPercent > 0;
  // A LINE booking's GST lives on its lines (gstMode is forced "none" there),
  // so the preview states it from the lines — same figures the PDF prints.
  const lines = booking.lineItems || [];
  const lineGst = lines.length ? computeLineTotals(lines, gstPercent) : null;
  return {
    bookingValue: totals.bookingValue,
    additional: totals.additional,
    /** Revenue: agreed + extras. */
    charged: totals.charged,
    /** Held and returned — inside `total`, never revenue. */
    refundable: totals.refundable,
    total: totals.total,
    received: totals.received,
    balance: totals.balance,
    pending: totals.pending,
    additionalLines: rows
      .filter((r) => r.isAdditional)
      .map((r) => ({ label: r.label, amount: r.amount, note: r.addedNote, addedByName: r.addedByName })),
    receiptCount: rows.reduce(
      (n, r) => n + (r.entries || []).filter((e) => (e.status || "approved") === "approved").length,
      0
    ),
    invoiceCount: invoices.length,
    // What the document will SAY about GST, so the owner reads it before
    // generating rather than discovering it in the PDF.
    gst: lineGst && lineGst.gst > 0
      ? {
          on: true,
          mode: "lines",
          percent: gstPercent,
          taxable: lineGst.taxable,
          amount: lineGst.gst,
          note:
            `GST at ${gstPercent}% applies to the taxable portion of the quoted lines and is stated on each invoice. ` +
            `The totals follow the agreed schedule, which is recorded exclusive of GST.`,
        }
      : {
          on: gstOn,
          mode: gstMode,
          percent: gstPercent,
          instalmentsBearing: gstOn && gstMode === "per_instalment" ? rows.filter((r) => r.gstApplicable).length : gstOn ? rows.length : 0,
          instalments: rows.length,
          /**
           * The honest sentence, and the reason it is worded this way:
           * summarizeSchedule is GST-agnostic (it has no reference to GST at all),
           * so the totals follow the schedule and tax is stated where it was
           * charged rather than added into a new grand total nothing holds.
           */
          note: gstOn
            ? "GST is stated per instalment and on each invoice. The totals follow the agreed schedule, which is recorded exclusive of GST."
            : "GST is not applicable on this booking.",
        },
    scheduleMatchesValue: totals.scheduleMatchesValue,
  };
}

// ── GET /venues/:slug/enquiries/:enquiryId/statement/preview ─────────────────
const previewStatement = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const gathered = await gatherStatement(owned.venue, owned.lead);
    if (gathered.error) {
      return res.status(409).json({ message: gathered.error, code: "no_booking" });
    }
    return res.status(200).json({ preview: previewOf(gathered) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/statement ────────────────────────
const createStatement = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;

    const gathered = await gatherStatement(venue, lead);
    if (gathered.error) {
      return res.status(409).json({ message: gathered.error, code: "no_booking" });
    }
    const { booking, summary, invoices } = gathered;

    let rendered;
    try {
      // The document system renders the venue's chosen language; gstStated
      // keeps its meaning (the statement names GST when the lines bear any).
      const { buildVenueDocument } = require("../utils/docsystem");
      const { loadLogoBuffer } = require("../utils/venuePdf");
      const logoBuffer = await loadLogoBuffer(venue.logo);
      const built = await buildVenueDocument("statement", { venue, lead, booking, summary, logoBuffer });
      rendered = { buffer: built.buffer, gstStated: (built.data.totals.gst + built.data.totals.extrasGst) > 0 };
    } catch (e) {
      console.error(`[venueLeadStatement] render failed for lead ${lead._id}: ${e.message}`);
      return res.status(500).json({
        message: "The statement could not be produced. Nothing was saved — please try again.",
        code: "render_failed",
      });
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `statement-${String(booking.coupleName || "booking").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v.pdf`;
    let url;
    try {
      url = await uploadBufferToS3({
        buffer: rendered.buffer,
        key: `venues/${venue._id}/statements/${stamp}.pdf`,
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error(`[venueLeadStatement] S3 upload failed for lead ${lead._id}: ${e.message}`);
      // SAID OUT LOUD. A storage failure that returned a bare 500 would read on
      // screen as "nothing happened", and the owner would press the button again.
      return res.status(502).json({
        message: "The statement was produced but could not be stored. Nothing was saved — please report this.",
        code: "storage_failed",
      });
    }

    const note = cleanStr(req.body && req.body.note).slice(0, MAX_NOTE);
    const generatedByName = await actorName(req);
    const t = summary.totals || {};
    const doc = await insertNextVersion(
      {
        venue: venue._id,
        enquiry: lead._id,
        kind: "statement",
        // The default note carries the two numbers that make a version list
        // legible six weeks later. Without them it is N rows of "Statement".
        note:
          note ||
          `Balance Rs. ${Math.round(t.balance || 0).toLocaleString("en-IN")} of Rs. ${Math.round(t.total || 0).toLocaleString("en-IN")}`,
        url,
        sizeBytes: rendered.buffer.length,
        contentType: "application/pdf",
        source: { url: "", filename: "", sizeBytes: null },
        sourceVerified: false,
        cover: {
          coupleName: booking.coupleName || lead.coupleName || "",
          phone: booking.couplePhone || lead.couplePhone || "",
          eventDates: (booking.days || []).map((d) => d && d.date).filter(Boolean),
          quotedAmount: t.total,
        },
        generatedBy: actorId(req),
        generatedByName,
      },
      (version) => ({ filename: filename.replace(/-v\.pdf$/, `-v${version}.pdf`) })
    );

    lead.activities.push({
      type: "document_generated",
      description: `Statement of account generated — balance Rs. ${Math.round(t.balance || 0).toLocaleString("en-IN")} of Rs. ${Math.round(t.total || 0).toLocaleString("en-IN")}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(201).json({
      success: true,
      document: { _id: doc._id, version: doc.version, filename: doc.filename, note: doc.note, kind: doc.kind },
      // The same shape the preview returns, from the same computation, so a
      // caller can render the result without a second round trip.
      preview: previewOf(gathered),
      gstStated: rendered.gstStated,
      downloadPath: `/venues/${venue.slug}/enquiries/${lead._id}/documents/${doc._id}/download`,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { previewStatement, createStatement, gatherStatement, previewOf };

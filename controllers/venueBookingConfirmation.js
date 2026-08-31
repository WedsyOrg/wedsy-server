/**
 * controllers/venueBookingConfirmation.js — S3: generate the booking
 * confirmation from the booking.
 *
 * Reuses the #130 document infrastructure wholesale: the artefact is a
 * VenueLeadDocument of kind "booking_confirmation", so it lands in the same
 * Documents tab with the same versioning, notes, immutability and download path
 * as the T&Cs and the invoices. `kind` was already an enum and the tab is
 * kind-agnostic, so nothing in the UI had to learn a new shape.
 *
 * ── THE OPTIONAL T&C ATTACHMENT ─────────────────────────────────────────────
 * When asked for, the venue's uploaded T&C PDF is stitched AFTER the
 * confirmation using utils/pdfStitch — the same function that puts a cover in
 * front of the T&Cs in #130, with the roles reversed. That matters: it means the
 * venue's PDF is carried, not re-rendered, and verifySourcePreserved asserts
 * per-page that it came through unchanged. A confirmation that quietly reflowed
 * a venue's terms would be worse than one that omitted them.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
const { BRANDING_SELECT } = require("../utils/venueBranding");
const { buildBookingConfirmationPdf } = require("../utils/venueBookingConfirmationPdf");
const { fetchSourcePdf, stitchCoverOntoPdf, verifySourcePreserved, StitchError } = require("../utils/pdfStitch");
const { uploadBufferToS3 } = require("../utils/s3Upload");
const { insertNextVersion } = require("./venueLeadDocument");

const MAX_NOTE = 2000;

async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    .select(`${BRANDING_SELECT} cancellationPolicy termsDocument`)
    .lean();
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

// ── GET .../booking-confirmation/options ────────────────────────────────────
// What the generate dialog needs in order to offer its two checkboxes honestly:
// neither should be offered when there is nothing behind it.
const getConfirmationOptions = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const booking = await VenueBooking.findOne({ enquiry: lead._id }).select("_id totalValue paymentSchedule days lineItems").lean();
    const policyBlocks = (venue.cancellationPolicy && venue.cancellationPolicy.blocks) || [];
    // Held money, stated beside the value so the dialog can say what the
    // document will say: payable includes the deposit, revenue does not.
    const refundable = ((booking && booking.lineItems) || [])
      .filter((li) => li && li.refundable)
      .reduce((s, li) => s + (Math.round(Number(li.amount)) || 0), 0);
    return res.status(200).json({
      hasBooking: Boolean(booking),
      bookingValue: booking ? Number(booking.totalValue) || 0 : 0,
      refundableHeld: refundable,
      payable: (booking ? Number(booking.totalValue) || 0 : 0) + refundable,
      scheduleRows: booking ? (booking.paymentSchedule || []).length : 0,
      hasCancellationPolicy: policyBlocks.length > 0,
      hasTermsDocument: Boolean(venue.termsDocument && venue.termsDocument.url),
      termsFilename: (venue.termsDocument && venue.termsDocument.filename) || "",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST .../booking-confirmation ───────────────────────────────────────────
// Body: { includeCancellationPolicy?: boolean, attachTerms?: boolean, note?: string }
const generateBookingConfirmation = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id }).lean();
    if (!booking) {
      return res.status(400).json({
        message: "This lead has no confirmed booking yet — confirm the booking first.",
        code: "no_booking",
      });
    }

    const wantPolicy = body.includeCancellationPolicy === true || body.includeCancellationPolicy === "true";
    const wantTerms = body.attachTerms === true || body.attachTerms === "true";
    const policyBlocks = (venue.cancellationPolicy && venue.cancellationPolicy.blocks) || [];
    if (wantPolicy && !policyBlocks.length) {
      return res.status(400).json({
        message: "No cancellation policy written yet. Add one in Settings, then include it here.",
        code: "no_cancellation_policy",
      });
    }
    if (wantTerms && !(venue.termsDocument && venue.termsDocument.url)) {
      return res.status(400).json({
        message: "No T&C PDF uploaded yet. Add it in Settings, then attach it here.",
        code: "no_terms_document",
      });
    }

    const issuedAt = new Date();
    const built = await buildBookingConfirmationPdf({
      venue,
      booking,
      lead,
      includeCancellationPolicy: wantPolicy,
      issuedAt,
    });

    // ── attach the venue's own T&C PDF, carried not re-rendered ────────────
    let buffer = built.buffer;
    let attached = null;
    if (wantTerms) {
      let sourceBuffer;
      try {
        sourceBuffer = await fetchSourcePdf(venue.termsDocument.url);
        const stitched = await stitchCoverOntoPdf(buffer, sourceBuffer);
        // The same promise #130 makes: the venue's pages come through unchanged.
        const verified = await verifySourcePreserved(stitched.buffer, sourceBuffer, { coverPages: stitched.coverPages });
        if (!verified.ok) {
          console.error(`[bookingConfirmation] stitch altered the T&Cs for lead ${lead._id}: ${verified.reason || verified.mismatches.join(",")}`);
          return res.status(500).json({
            message: "The attached terms did not come through unchanged, so nothing was saved. Please report this.",
            code: "terms_not_preserved",
          });
        }
        buffer = stitched.buffer;
        attached = { filename: venue.termsDocument.filename || "terms.pdf", pages: stitched.sourcePages };
        sourceBuffer = null; // largest thing held; released before upload
      } catch (e) {
        if (e instanceof StitchError) return res.status(e.status || 400).json({ message: e.message, code: e.code });
        throw e;
      }
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeCouple = (booking.coupleName || "booking").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "booking";
    let url;
    try {
      url = await uploadBufferToS3({
        buffer,
        key: `venues/${venue._id}/booking-confirmations/${stamp}.pdf`,
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error(`[bookingConfirmation] S3 upload failed for lead ${lead._id}: ${e.message}`);
      return res.status(502).json({
        message: "The confirmation was generated but could not be stored — nothing was sent. Try again.",
        code: "storage_failed",
      });
    }

    const note = cleanStr(body.note).slice(0, MAX_NOTE);
    const doc = await insertNextVersion(
      {
        venue: venue._id,
        enquiry: lead._id,
        kind: "booking_confirmation",
        note:
          note ||
          [wantPolicy ? "with cancellation policy" : "", attached ? `with ${attached.filename}` : ""].filter(Boolean).join(", ") ||
          "Booking confirmation",
        url,
        sizeBytes: buffer.length,
        contentType: "application/pdf",
        sourcePages: attached ? attached.pages : undefined,
        source: attached
          ? { url: venue.termsDocument.url, filename: attached.filename, sizeBytes: venue.termsDocument.sizeBytes || null }
          : { url: "", filename: "", sizeBytes: null },
        sourceVerified: Boolean(attached),
        generatedBy: actorId(req),
        generatedByName: await actorName(req),
      },
      (version) => ({ filename: `booking-confirmation-${safeCouple}-v${version}.pdf` })
    );

    const leadDoc = await require("../models/VenueEnquiry").findById(lead._id);
    leadDoc.activities.push({
      type: "booking_confirmation_generated",
      description:
        `Booking confirmation v${doc.version} generated` +
        `${wantPolicy ? " with the cancellation policy" : ""}` +
        `${attached ? `${wantPolicy ? " and" : " with"} ${attached.filename} attached` : ""}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await leadDoc.save();

    return res.status(201).json({
      success: true,
      document: { _id: doc._id, version: doc.version, filename: doc.filename, note: doc.note, sizeBytes: doc.sizeBytes },
      includedCancellationPolicy: built.includedPolicy,
      attachedTerms: attached,
      tableStats: built.tableStats,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getConfirmationOptions, generateBookingConfirmation };

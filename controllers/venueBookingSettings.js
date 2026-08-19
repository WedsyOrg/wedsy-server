/**
 * controllers/venueBookingSettings.js — S1: the venue-level CONFIGURATION the
 * booking engine reads.
 *
 * THE SPLIT THIS FILE EXISTS TO PROTECT: Settings holds configuration; the lead
 * detail page is where work happens. Nothing here is ever copied onto a lead or
 * a booking as a setting — the wizard READS these to pre-populate, and what it
 * writes onto the booking is the owner's decision for that booking, not a
 * mirror of the venue's preference. So a venue changing its default shape next
 * month does not silently rewrite a schedule already agreed with a couple.
 *
 * Three surfaces:
 *   b) venue brief PDF     — pointer only, same mechanism as termsDocument
 *   c) cancellation policy — constrained block tree (utils/venueRichText)
 *   d) payment slabs       — shapes, validated by utils/venuePaymentSchedule
 *
 * S1a (branding) has NO endpoint here on purpose. Every field it needs already
 * exists on Venue and is already edited from Settings → Profile and Settings →
 * Billing & tax. Adding a third writer would be the duplication the brief
 * forbids; the consolidation is utils/venueBranding, which gives every document
 * ONE resolved answer instead of each renderer inventing its own fallbacks.
 */
const Venue = require("../models/Venue");
const VenueTeamMember = require("../models/VenueTeamMember");
const { normalizeBlocks, blocksToPlainText, RichTextError, MAX_TOTAL_CHARS } = require("../utils/venueRichText");
const { normalizeSlabs, BUILTIN_SLABS, ScheduleError } = require("../utils/venuePaymentSchedule");
const { resolveBranding, BRANDING_SELECT } = require("../utils/venueBranding");

const PDF_MIME = "application/pdf";
const MAX_BYTES = 10 * 1024 * 1024; // same ceiling as the T&C upload

/**
 * Venue by slug, owned by the caller. 404 (never 403) for a foreign venue —
 * the same rule the lead scoping uses, because telling a caller a venue exists
 * but is not theirs is itself a leak.
 */
async function resolveOwnedVenue(req, res, select = BRANDING_SELECT) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(
    `${select} briefDocument cancellationPolicy termsDocument`
  );
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  return venue;
}

async function actorName(req) {
  if (req.admin) return "Wedsy admin";
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    return (m && m.name) || "team member";
  }
  return o.name || "Owner";
}
const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;

/** Always an object, so the UI never branches on null. */
const presentDoc = (d) => {
  const doc = d || {};
  if (!doc.url) return { uploaded: false };
  return {
    uploaded: true,
    url: doc.url,
    filename: doc.filename || "document.pdf",
    sizeBytes: doc.sizeBytes || null,
    uploadedAt: doc.uploadedAt || null,
    uploadedByName: doc.uploadedByName || "",
  };
};

const presentPolicy = (p) => {
  const pol = p || {};
  const blocks = Array.isArray(pol.blocks) ? pol.blocks : [];
  return {
    present: blocks.length > 0,
    blocks,
    plainText: blocksToPlainText(blocks),
    updatedAt: pol.updatedAt || null,
    updatedByName: pol.updatedByName || "",
  };
};

// ── GET /venues/:slug/booking-settings ──────────────────────────────────────
// One read for the whole S1 surface, so the Settings page and the wizard do not
// each assemble it from three calls and disagree about what is configured.
const getBookingSettings = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const saved = (venue.settings && venue.settings.paymentSlabs) || [];
    return res.status(200).json({
      branding: resolveBranding(venue),
      brief: presentDoc(venue.briefDocument),
      // The T&C doc is reported (not editable here) because S3 offers to attach
      // it, and the UI needs to know whether that option is even available.
      terms: presentDoc(venue.termsDocument),
      cancellationPolicy: presentPolicy(venue.cancellationPolicy),
      paymentSlabs: saved,
      // The wizard falls back to these when the venue has saved none. Sent so
      // the shape list is identical in Settings and in the wizard.
      builtinSlabs: BUILTIN_SLABS,
      limits: { policyMaxChars: MAX_TOTAL_CHARS, briefMaxBytes: MAX_BYTES },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PUT /venues/:slug/booking-settings/brief ────────────────────────────────
// The FILE never touches this controller: it goes up through the existing
// POST /file/upload → S3 path, which already scopes keys to the venue. This
// stores the pointer, exactly as the T&C upload does.
const putBrief = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const b = req.body || {};
    const url = String(b.url || "").trim();
    const filename = String(b.filename || "").trim();
    const contentType = String(b.contentType || "").trim();
    const sizeBytes = Number(b.sizeBytes);

    if (!/^https:\/\//.test(url)) return res.status(400).json({ message: "A stored https URL is required" });
    if (!/\.pdf$/i.test(filename)) return res.status(400).json({ message: "The venue brief must be a PDF" });
    if (contentType !== PDF_MIME) return res.status(400).json({ message: `contentType must be ${PDF_MIME}` });
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return res.status(400).json({ message: "sizeBytes is required" });
    if (sizeBytes > MAX_BYTES) {
      return res.status(400).json({ message: `That file is too large (max ${MAX_BYTES / 1048576} MB)` });
    }

    venue.briefDocument = {
      url,
      filename,
      contentType,
      sizeBytes,
      uploadedAt: new Date(),
      uploadedBy: actorId(req),
      uploadedByName: await actorName(req),
    };
    await venue.save();
    return res.status(200).json({ success: true, brief: presentDoc(venue.briefDocument) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── DELETE /venues/:slug/booking-settings/brief ─────────────────────────────
// Clears the pointer and deliberately LEAVES the S3 object, same as the T&C
// delete: a brief already sent to a couple must keep resolving.
const deleteBrief = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    venue.briefDocument = undefined;
    await venue.save();
    return res.status(200).json({ success: true, brief: { uploaded: false } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PUT /venues/:slug/booking-settings/cancellation-policy ──────────────────
const putCancellationPolicy = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    let normalized;
    try {
      normalized = normalizeBlocks((req.body || {}).blocks);
    } catch (e) {
      if (e instanceof RichTextError) return res.status(400).json({ message: e.message, code: e.code });
      throw e;
    }
    venue.cancellationPolicy = {
      blocks: normalized.blocks,
      updatedAt: new Date(),
      updatedBy: actorId(req),
      updatedByName: await actorName(req),
    };
    await venue.save();
    return res.status(200).json({
      success: true,
      cancellationPolicy: presentPolicy(venue.cancellationPolicy),
      chars: normalized.totalChars,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PUT /venues/:slug/booking-settings/payment-slabs ────────────────────────
const putPaymentSlabs = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    let slabs;
    try {
      slabs = normalizeSlabs((req.body || {}).paymentSlabs);
    } catch (e) {
      if (e instanceof ScheduleError) return res.status(400).json({ message: e.message, code: e.code });
      throw e;
    }
    // settings is a nested object; assign the key rather than replacing the
    // object, or every other venue setting is wiped by a slab save.
    venue.settings = venue.settings || {};
    venue.settings.paymentSlabs = slabs;
    venue.markModified("settings.paymentSlabs");
    await venue.save();
    return res.status(200).json({ success: true, paymentSlabs: slabs });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getBookingSettings,
  putBrief,
  deleteBrief,
  putCancellationPolicy,
  putPaymentSlabs,
  presentDoc,
  presentPolicy,
  MAX_BYTES,
};

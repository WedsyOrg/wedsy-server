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
const {
  DEFAULT_BOOKING_CHARGES,
  chargeKeyFor,
  checkChargeMoney,
  presentCharges,
  chargeSuggestions,
} = require("../utils/venueBookingCharges");
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
    `${select} briefDocument cancellationPolicy termsDocument bookingCharges`
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
      // Standing charges + the seed entries not yet added, in the one read the
      // Settings page makes — same reason branding and slabs are here.
      bookingCharges: presentCharges(venue),
      chargeSuggestions: chargeSuggestions(venue),
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

/* ══ STANDING CHARGES — the charge library (money lines S2) ═════════════════
 * The amenity endpoints' shape (list + suggestions, add-or-seed, patch,
 * delete), with the one ruled difference spelled out on DELETE below. */

// ── GET /venues/:slug/booking-settings/charges ──────────────────────────────
// The picker's read: the venue's list plus whatever of the seed is not on it.
const listBookingCharges = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json({
      charges: presentCharges(venue),
      suggestions: chargeSuggestions(venue),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/** Shared by add and update: the money fields, validated as one shape. */
function chargeMoneyFrom(body, current, where) {
  return checkChargeMoney(
    {
      amount: body.defaultAmount !== undefined ? body.defaultAmount : (current && current.defaultAmount) || 0,
      gstTreatment: body.gstTreatment !== undefined ? body.gstTreatment : (current && current.gstTreatment) || "none",
      taxableAmount: body.taxableAmount !== undefined ? body.taxableAmount : (current && current.taxableAmount) || 0,
      refundable: body.refundable !== undefined ? body.refundable : Boolean(current && current.refundable),
    },
    where
  );
}

// ── POST /venues/:slug/booking-settings/charges ─────────────────────────────
// Body: { label, defaultAmount?, gstTreatment?, taxableAmount?, refundable? }
// for one, or { seed: true } to add whatever of the starting set is missing.
// Seeding is additive and idempotent — it never removes or relabels a charge
// the owner already has (the amenity seeding rule, verbatim).
const addBookingCharge = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    venue.bookingCharges = venue.bookingCharges || [];
    const existing = new Set(venue.bookingCharges.map((c) => String(c.key)));

    if (body.seed) {
      const added = [];
      for (const d of DEFAULT_BOOKING_CHARGES) {
        if (existing.has(d.key)) continue;
        venue.bookingCharges.push({
          key: d.key,
          label: d.label,
          defaultAmount: 0,
          gstTreatment: "none",
          taxableAmount: 0,
          refundable: Boolean(d.refundable),
        });
        added.push(d.key);
      }
      await venue.save();
      return res.status(200).json({ seeded: added.length, charges: presentCharges(venue), suggestions: chargeSuggestions(venue) });
    }

    const label = String(body.label || "").trim().slice(0, 80);
    if (!label) return res.status(400).json({ message: "A charge needs a name" });
    const key = chargeKeyFor(body.key || label);
    if (!key) return res.status(400).json({ message: "That name has no letters or numbers in it." });

    // Label AND key, both ways — the amenity collision rule: the key
    // derivation is lossy, and two entries the owner cannot tell apart on any
    // screen is the failure being prevented.
    const wanted = label.toLowerCase();
    const clash = venue.bookingCharges.find(
      (c) => String(c.key) === key || String(c.label || "").trim().toLowerCase() === wanted
    );
    if (clash) {
      return res.status(409).json({
        message: `"${clash.label}" is already on the list.`,
        code: "charge_exists",
        charge: { key: clash.key, label: clash.label },
      });
    }

    const money = chargeMoneyFrom(body, null, "charge");
    if (!money.ok) return res.status(400).json({ message: money.message });

    venue.bookingCharges.push({
      key,
      label,
      defaultAmount: money.value.amount,
      gstTreatment: money.value.gstTreatment,
      taxableAmount: money.value.taxableAmount,
      refundable: money.value.refundable,
    });
    await venue.save();
    return res.status(201).json({
      charge: presentCharges(venue).find((c) => c.key === key),
      charges: presentCharges(venue),
      suggestions: chargeSuggestions(venue),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /venues/:slug/booking-settings/charges/:key ───────────────────────
// The KEY is immutable identity; everything else moves. Editing here changes
// only what the NEXT pick copies — lines already on quotes hold their own
// values and must never move because Settings did.
const updateBookingCharge = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const charge = (venue.bookingCharges || []).find((c) => String(c.key) === String(req.params.key));
    if (!charge) return res.status(404).json({ message: "Charge not found" });
    const body = req.body || {};

    if (body.label !== undefined) {
      const label = String(body.label || "").trim().slice(0, 80);
      if (!label) return res.status(400).json({ message: "A charge needs a name" });
      const wanted = label.toLowerCase();
      const clash = (venue.bookingCharges || []).find(
        (c) => String(c.key) !== String(charge.key) && String(c.label || "").trim().toLowerCase() === wanted
      );
      if (clash) return res.status(409).json({ message: `"${clash.label}" is already on the list.`, code: "charge_exists" });
      charge.label = label;
    }

    const money = chargeMoneyFrom(body, charge, "charge");
    if (!money.ok) return res.status(400).json({ message: money.message });
    charge.defaultAmount = money.value.amount;
    charge.gstTreatment = money.value.gstTreatment;
    charge.taxableAmount = money.value.taxableAmount;
    charge.refundable = money.value.refundable;

    await venue.save();
    return res.status(200).json({
      charge: presentCharges(venue).find((c) => c.key === String(req.params.key)),
      charges: presentCharges(venue),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── DELETE /venues/:slug/booking-settings/charges/:key ──────────────────────
// A HARD DELETE, even when quotes use the charge — ruled, and safe by
// construction: a line holds a COPY of the charge's values from the moment of
// the pick, and nothing resolves back through the key. This is deliberately
// NOT the amenity rule (unused deletes, in-use retires): amenities retire
// because rooms and types hold the amenity's KEY as a live reference. If you
// are adding retirement here "for consistency", the consistency that matters
// is copy-vs-reference — tests/venue-money-lines fails on an isActive field
// appearing in this list. Lines already on quotes and bookings stay exactly
// as they are until deleted from that document by hand.
const deleteBookingCharge = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const idx = (venue.bookingCharges || []).findIndex((c) => String(c.key) === String(req.params.key));
    if (idx === -1) return res.status(404).json({ message: "Charge not found" });
    venue.bookingCharges.splice(idx, 1);
    await venue.save();
    return res.status(200).json({
      deleted: true,
      message: "Deleted from the library. Lines already on quotes and bookings keep their copied values.",
      charges: presentCharges(venue),
      suggestions: chargeSuggestions(venue),
    });
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
  listBookingCharges,
  addBookingCharge,
  updateBookingCharge,
  deleteBookingCharge,
  presentDoc,
  presentPolicy,
  MAX_BYTES,
};

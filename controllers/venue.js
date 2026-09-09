const VenueService = require("../services/VenueService");
const { verifiedBadge, partnerBadge } = require("../utils/venueTracks");

const getVenues = async (req, res) => {
  try {
    const { status, limit = 100, skip = 0, zone, area, search, venueType, amenities, veg, nonVeg, minCapacity, minPrice, maxPrice, sort } = req.query;
    // Admin: use the status query as-is (undefined = all statuses, no filter).
    // Non-admin (public/couples): keep the current default-to-published behavior.
    const effectiveStatus = req.admin ? status : status || "published";
    const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const result = await VenueService.getAllVenues({
      status: effectiveStatus,
      limit: parseInt(limit),
      skip: parseInt(skip),
      zone: trimmed(zone),
      area: trimmed(area),
      search: trimmed(search),
      venueType: trimmed(venueType),
      amenities: trimmed(amenities),
      veg, nonVeg,
      minCapacity: trimmed(minCapacity),
      minPrice: trimmed(minPrice),
      maxPrice: trimmed(maxPrice),
      sort: trimmed(sort),
    });
    // MB-OSV S0 — the two derived badges, same implementation as the detail
    // response and the admin reads (utils/venueTracks). `isVerified` keeps its
    // API name exactly as promised when it was derived from status, so the
    // couple-side frontend needed no change; only the derivation moved.
    const venues = (result.venues || []).map((v) => ({
      ...v,
      isVerified: verifiedBadge(v),
      isPartner: partnerBadge(v),
    }));
    return res.status(200).json({ ...result, venues });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Backward-compatible structured policies. If policyDoc has no content yet,
// migrate the legacy `policies` object into it on read (never lost):
//   otherRestrictions -> policyDoc.policies, cancellation+refund -> policyDoc.refund.
function withPolicyDoc(venue) {
  if (!venue) return venue;
  const pd = venue.policyDoc || {};
  const has = (a) => Array.isArray(a) && a.length > 0;
  if (has(pd.policies) || has(pd.terms) || has(pd.refund)) {
    venue.policyDoc = { policies: pd.policies || [], terms: pd.terms || [], refund: pd.refund || [] };
    return venue;
  }
  const legacy = venue.policies || {};
  const clean = (...vals) => vals.map((s) => (s == null ? "" : String(s).trim())).filter(Boolean);
  venue.policyDoc = {
    policies: clean(legacy.otherRestrictions),
    terms: [],
    refund: clean(legacy.cancellation, legacy.refund),
  };
  return venue;
}

const getVenueBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = withPolicyDoc(await VenueService.getVenueBySlug(slug));
    // Public detail exposes the aggregate rating + count ONLY — individual
    // Google review texts are an owner-dashboard surface, not a public API.
    if (venue) {
      delete venue.googleReviews;
      delete venue.googleReviewsRefreshedAt;
    }
    // MB-OSV S0 — this is the change that comment anticipated. Verification is
    // now a real orthogonal boolean (verified.isVerified) instead of a reading
    // of the publication status, and the derivation lives in ONE place for the
    // public read, the browse list and every admin surface. The `isVerified`
    // API name is unchanged, so the couple-side frontend needed zero change.
    //
    // isPartner joins it: granted access AND a first owner sign-in. The two are
    // independent — a venue can carry either badge without the other.
    const isVerified = verifiedBadge(venue);
    const isPartner = partnerBadge(venue);
    return res.status(200).json({ venue, isVerified, isPartner });
  } catch (err) {
    if (err.message === "Venue not found") {
      return res.status(404).json({ message: "Venue not found" });
    }
    return res.status(500).json({ message: err.message });
  }
};

const { backfillNewSpaceIntoWholeVenueBlocks } = require("../utils/venueWholeVenue");

const updateVenue = async (req, res) => {
  try {
    const { slug } = req.params;
    // Admin: bypass the venue-ownership check by resolving the venue's own _id and
    // passing it as the owner id (so the service check passes) — no service change.
    // Non-admin (venue_owner): keep the existing ownership check via req.venueOwner.venueId.
    let ownerVenueId;
    if (req.admin) {
      const existing = await VenueService.getVenueBySlug(slug);
      ownerVenueId = existing._id;
    } else {
      ownerVenueId = req.venueOwner.venueId;
    }
    // D10: identify the actor so the activity spine records who changed what.
    const { actorFromReq } = require("../utils/venueActivity");
    const actor = await actorFromReq(req);
    // Space ids BEFORE the write, so a newly added space can be identified
    // afterwards. See the backfill below for why that matters.
    const beforeVenue = await VenueService.getVenueBySlug(slug).catch(() => null);
    const beforeSpaceIds = new Set(((beforeVenue && beforeVenue.spaces) || []).map((s) => String(s._id)));

    // Bank details are refused with the reason at the door — the IFSC and UPI
    // have shapes a typo breaks silently, everything else is deliberately
    // shape-free (utils/venueBankDetails has the ruling).
    if (req.body && req.body.bankDetails && typeof req.body.bankDetails === "object") {
      const { validateBankDetails } = require("../utils/venueBankDetails");
      const bd = validateBankDetails(req.body.bankDetails);
      if (!bd.ok) return res.status(400).json({ message: bd.message });
      req.body.bankDetails = bd.value;
    }

    const venue = await VenueService.updateVenueBySlug(
      slug,
      ownerVenueId,
      req.body || {},
      actor
    );

    /**
     * A SPACE ADDED WHILE THE WHOLE PROPERTY IS ALREADY SOLD.
     *
     * "Entire property" is stored by claiming every bookable space on the date
     * (see utils/venueWholeVenue.js). A space created afterwards has no row on
     * those dates, so it would be bookable — "impossible unless someone edits
     * their listing", which is not impossible.
     *
     * So every newly added space is backfilled onto EVERY future date the whole
     * property is already claimed for, not just the next one. The result is
     * REPORTED rather than assumed: a partial backfill comes back in the
     * response instead of passing quietly, because the failure mode it guards
     * against is a silent double-booking.
     */
    // ── THE GENERATED UPI QR FOLLOWS THE FACTS IT ENCODES ───────────────────
    // Saved a UPI ID → the QR is (re)generated from it. Cleared the ID → a
    // GENERATED QR goes with it (an uploaded one is the venue's own file and
    // only the explicit delete removes it). The venue NAME rides inside the
    // payload (pn=), so a rename regenerates too — a QR naming the old venue
    // is a QR announcing the wrong payee.
    try {
      const { generateUpiQr, EMPTY_QR } = require("../utils/venueUpiQr");
      const Venue = require("../models/Venue");
      const sentUpi = req.body && req.body.bankDetails && req.body.bankDetails.upiId !== undefined;
      const beforeUpi = (beforeVenue && beforeVenue.bankDetails && beforeVenue.bankDetails.upiId) || "";
      const beforeSource = (beforeVenue && beforeVenue.upiQr && beforeVenue.upiQr.source) || "";
      const effectiveUpi = sentUpi ? req.body.bankDetails.upiId : beforeUpi;
      const nameChanged = req.body && req.body.name !== undefined && beforeVenue && req.body.name !== beforeVenue.name;
      if (sentUpi || (nameChanged && beforeSource === "generated")) {
        if (effectiveUpi) {
          const qr = await generateUpiQr(effectiveUpi, venue.name);
          await Venue.updateOne({ _id: venue._id }, { $set: { upiQr: { dataUrl: qr.dataUrl, source: "generated", upiString: qr.upiString, updatedAt: new Date() } } });
        } else if (beforeSource === "generated") {
          await Venue.updateOne({ _id: venue._id }, { $set: { upiQr: { ...EMPTY_QR } } });
        }
      }
    } catch (qrErr) {
      // The venue's save must not be lost to a QR library hiccup — report it.
      console.error(`[venue:${slug}] UPI QR sync failed: ${qrErr.message}`);
    }

    const newSpaceIds = ((venue && venue.spaces) || [])
      .map((s) => s._id)
      .filter((id) => !beforeSpaceIds.has(String(id)));

    const backfills = [];
    for (const id of newSpaceIds) {
      const r = await backfillNewSpaceIntoWholeVenueBlocks(venue._id, id, {});
      if (r.dates > 0) backfills.push({ space: String(id), ...r });
      if (!r.ok) {
        console.error(
          `[venue:${slug}] entire-property backfill INCOMPLETE for space ${id}: ` +
            `${r.inserted + r.alreadyPresent}/${r.dates} dates covered, ${r.failed.length} failed`
        );
      }
    }

    const incomplete = backfills.filter((b) => !b.ok);
    if (incomplete.length) {
      // 207-shaped truth in a 200 body: the venue DID save, and the calendar is
      // not fully protected. Saying only one of those would be a lie.
      return res.status(200).json({
        venue,
        wholeVenueBackfill: { ok: false, details: backfills },
        warning:
          "The venue was saved, but a new space could not be added to every date where the entire property is already booked. " +
          "Check those dates before taking another booking.",
      });
    }
    return res.status(200).json({
      venue,
      ...(backfills.length ? { wholeVenueBackfill: { ok: true, details: backfills } } : {}),
    });
  } catch (err) {
    if (err.message === "Venue not found") return res.status(404).json({ message: err.message });
    if (err.message === "Forbidden") return res.status(403).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

const createVenue = async (req, res) => {
  try {
    const venue = await VenueService.createVenue(req.body || {});
    return res.status(201).json({ venue });
  } catch (err) {
    if (err.status === 400 || err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    return res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /venues/:slug/upi-qr — a venue with NO UPI ID uploads the QR its bank
 * app made. Same store as the generated route, so a document never cares
 * which produced it. Refused while a UPI ID is set: the generated QR is the
 * one whose contents we can PROVE, so it wins whenever it can exist.
 */
const uploadUpiQr = async (req, res) => {
  try {
    const { slug } = req.params;
    let ownerVenueId;
    if (req.admin) {
      const existing = await VenueService.getVenueBySlug(slug);
      ownerVenueId = existing._id;
    } else {
      ownerVenueId = req.venueOwner.venueId;
    }
    const Venue = require("../models/Venue");
    const venue = await Venue.findOne({ slug }).select("_id bankDetails upiQr").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(ownerVenueId)) return res.status(403).json({ message: "Forbidden" });
    if (venue.bankDetails && venue.bankDetails.upiId) {
      return res.status(400).json({
        message: "You have a UPI ID, so its QR is generated automatically. Clear the UPI ID first to use your own image.",
        code: "upi_id_generates",
      });
    }
    const { validateQrImageDataUrl } = require("../utils/venueUpiQr");
    const v = validateQrImageDataUrl((req.body || {}).image);
    if (!v.ok) return res.status(400).json({ message: v.message });
    const upiQr = { dataUrl: v.value, source: "uploaded", upiString: "", updatedAt: new Date() };
    await Venue.updateOne({ _id: venue._id }, { $set: { upiQr } });
    return res.status(200).json({ success: true, upiQr });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /venues/:slug/upi-qr — removes an UPLOADED QR. A generated QR's door
 * is the UPI ID itself (clear the ID and the QR goes with it) — deleting it
 * here while the ID stayed would just regenerate on the next save, a control
 * that lies.
 */
const deleteUpiQr = async (req, res) => {
  try {
    const { slug } = req.params;
    let ownerVenueId;
    if (req.admin) {
      const existing = await VenueService.getVenueBySlug(slug);
      ownerVenueId = existing._id;
    } else {
      ownerVenueId = req.venueOwner.venueId;
    }
    const Venue = require("../models/Venue");
    const venue = await Venue.findOne({ slug }).select("_id upiQr").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(ownerVenueId)) return res.status(403).json({ message: "Forbidden" });
    if (venue.upiQr && venue.upiQr.source === "generated") {
      return res.status(400).json({
        message: "This QR is generated from your UPI ID — clear the UPI ID to remove it.",
        code: "clear_upi_id_instead",
      });
    }
    const { EMPTY_QR } = require("../utils/venueUpiQr");
    await Venue.updateOne({ _id: venue._id }, { $set: { upiQr: { ...EMPTY_QR } } });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getVenues, getVenueBySlug, updateVenue,
  uploadUpiQr,
  deleteUpiQr, createVenue };

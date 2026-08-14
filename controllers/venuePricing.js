/**
 * controllers/venuePricing.js — the pricing advice read, and its off switches.
 *
 * TWO WAYS TO SILENCE IT, and they answer different questions:
 *   per-lead   — "I've read this, stop showing it on THIS deal." Stored on the
 *                lead, not per user, because the advice is about the deal: once
 *                it has been read and acted on it should stop occupying the top
 *                of the tab for everyone working the lead.
 *   venue-wide — "I price from experience, never show me this." A setting, so
 *                an owner who finds it noise is not dismissing it lead by lead
 *                for the rest of time.
 *
 * The venue-wide switch wins and short-circuits the whole computation — no
 * point doing four queries to build advice nobody will see.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { pricingIntelForLead } = require("../utils/venuePricingIntel");

async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id state city settings").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
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

// GET /venues/:slug/enquiries/:enquiryId/pricing
const getPricingIntel = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;

    const venueEnabled = !(venue.settings && venue.settings.pricingAdvice === false);
    const dismissed = lead.pricingAdviceDismissed === true;
    if (!venueEnabled) {
      return res.status(200).json({ enabled: false, reason: "venue_setting", dismissed, advice: "", signals: null });
    }

    const { advice, signals } = await pricingIntelForLead({
      venue,
      lead,
      venueOwner: req.venueOwner,
      venueMember: req.venueMember,
    });

    // The advice is still COMPUTED when dismissed — the UI wants the numbers
    // for the detail panel even with the banner closed, and re-opening it
    // should not need another round trip.
    return res.status(200).json({ enabled: true, dismissed, advice, signals });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/enquiries/:enquiryId/pricing/dismiss { dismissed?: boolean }
// Idempotent, and reversible — an owner who closes it by accident can reopen it.
const dismissPricingAdvice = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const next = (req.body || {}).dismissed === false ? false : true;
    owned.lead.pricingAdviceDismissed = next;
    await owned.lead.save();
    return res.status(200).json({ dismissed: next });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getPricingIntel, dismissPricingAdvice };

/**
 * controllers/venueCrmSettings.js — MB-CRM S7 owner-tunable CRM settings.
 * Currently just the auto-assign toggle (Venue.settings.autoAssignLeads).
 * Team-capability gated (owner surface).
 */
const Venue = require("../models/Venue");

async function resolveOwnedVenueDoc(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug });
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

// GET /venues/:slug/crm/settings
const getCrmSettings = async (req, res) => {
  try {
    const venue = await resolveOwnedVenueDoc(req, res);
    if (!venue) return;
    return res.status(200).json({ autoAssignLeads: Boolean(venue.settings && venue.settings.autoAssignLeads) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/crm/settings { autoAssignLeads: boolean }
const updateCrmSettings = async (req, res) => {
  try {
    const venue = await resolveOwnedVenueDoc(req, res);
    if (!venue) return;
    const { autoAssignLeads } = req.body || {};
    if (typeof autoAssignLeads !== "boolean") {
      return res.status(400).json({ message: "autoAssignLeads must be a boolean" });
    }
    if (!venue.settings) venue.settings = {};
    venue.settings.autoAssignLeads = autoAssignLeads;
    await venue.save();
    return res.status(200).json({ autoAssignLeads: venue.settings.autoAssignLeads });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getCrmSettings, updateCrmSettings };

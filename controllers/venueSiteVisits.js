/**
 * controllers/venueSiteVisits.js — MB-V2 P1: the OWNER side of planner
 * walk-throughs. Owners see visits for their own venue and move the status
 * (confirm / complete / cancel). Creation happens wedsy-side in the planner;
 * the full visit workflow is future work.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueSiteVisit = require("../models/VenueSiteVisit");

const resolveOwnVenue = async (req, res) => {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
};

// GET /venues/:slug/site-visits?status=
const listOwnSiteVisits = async (req, res) => {
  try {
    const venue = await resolveOwnVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    if (req.query.status) {
      if (!VenueSiteVisit.schema.path("status").enumValues.includes(req.query.status)) {
        return res.status(400).json({ message: "Unknown status" });
      }
      filter.status = req.query.status;
    }
    const visits = await VenueSiteVisit.find(filter)
      .sort({ scheduledAt: 1 })
      .limit(200)
      .populate("enquiryRef", "coupleName couplePhone stage")
      .lean();
    return res.status(200).json({ visits, total: visits.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/site-visits/:visitId  {status}
const updateOwnSiteVisit = async (req, res) => {
  try {
    const venue = await resolveOwnVenue(req, res);
    if (!venue) return;
    if (!mongoose.isValidObjectId(req.params.visitId)) {
      return res.status(400).json({ message: "Invalid visit id" });
    }
    const visit = await VenueSiteVisit.findById(req.params.visitId);
    if (!visit || String(visit.venue) !== String(venue._id)) {
      return res.status(404).json({ message: "Visit not found" });
    }
    const { status } = req.body || {};
    if (!status || !VenueSiteVisit.schema.path("status").enumValues.includes(status)) {
      return res.status(400).json({ message: "Unknown status" });
    }
    visit.status = status;
    await visit.save();
    return res.status(200).json({ visit: visit.toObject() });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listOwnSiteVisits, updateOwnSiteVisit };

/**
 * controllers/venueActivityFeed.js — D10 owner-side read of the activity
 * spine: their own venue's trail, filterable, newest first. No write routes
 * exist anywhere (append-only is enforced at the model).
 */
const Venue = require("../models/Venue");
const VenueActivity = require("../models/VenueActivity");

const listActivity = async (req, res) => {
  try {
    const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) return res.status(403).json({ message: "Forbidden" });

    const filter = { venue: venue._id };
    const { severity, entity, actorType, from, to } = req.query;
    if (severity) {
      const list = String(severity).split(",").filter(Boolean);
      if (list.some((s) => !["high", "normal", "low"].includes(s))) return res.status(400).json({ message: "Unknown severity" });
      filter.severity = { $in: list };
    }
    if (entity) filter.entity = String(entity).slice(0, 100);
    if (actorType) {
      if (!["venue_team", "wedsy_team", "system"].includes(actorType)) return res.status(400).json({ message: "Unknown actorType" });
      filter.actorType = actorType;
    }
    if (from || to) {
      filter.at = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "from is not a valid date" });
        filter.at.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "to is not a valid date" });
        filter.at.$lte = d;
      }
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const activity = await VenueActivity.find(filter).sort({ at: -1 }).limit(limit).lean();
    return res.status(200).json({ activity, total: activity.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { listActivity };

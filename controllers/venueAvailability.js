const Venue = require("../models/Venue");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const saveAvailability = async (req, res) => {
  try {
    const { slug } = req.params;
    const { blockedDates } = req.body || {};

    if (!Array.isArray(blockedDates)) {
      return res.status(400).json({ message: "blockedDates must be an array" });
    }
    if (!blockedDates.every((d) => typeof d === "string" && ISO_DATE_RE.test(d))) {
      return res.status(400).json({ message: "blockedDates entries must be YYYY-MM-DD strings" });
    }

    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const dedup = Array.from(new Set(blockedDates)).sort();

    const updated = await Venue.findByIdAndUpdate(
      venue._id,
      { $set: { blockedDates: dedup } },
      { new: true }
    )
      .select("_id slug blockedDates")
      .lean();

    return res.status(200).json({ success: true, blockedDates: updated.blockedDates });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/availability-check?date=YYYY-MM-DD — PUBLIC single-date read.
// Returns { date, status: available | unavailable | unknown }. Never leaks the
// full calendar: only answers for the one requested date. "unknown" = the venue
// has not configured availability yet (empty blockedDates).
const availabilityCheck = async (req, res) => {
  try {
    const { slug } = req.params;
    const date = (req.query.date || "").trim();
    if (!ISO_DATE_RE.test(date)) {
      return res.status(400).json({ message: "date must be a YYYY-MM-DD string" });
    }
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ message: "date is not a valid calendar date" });
    }
    const venue = await Venue.findOne({ slug }).select("blockedDates").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    const blocked = Array.isArray(venue.blockedDates) ? venue.blockedDates : [];
    let status;
    if (blocked.length === 0) status = "unknown";
    else if (blocked.includes(date)) status = "unavailable";
    else status = "available";
    return res.status(200).json({ date, status });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { saveAvailability, availabilityCheck };

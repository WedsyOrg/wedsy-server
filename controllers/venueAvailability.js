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

module.exports = { saveAvailability };

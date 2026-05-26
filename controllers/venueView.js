const Venue = require("../models/Venue");
const VenueView = require("../models/VenueView");

// Fire-and-forget view tracking. Always returns 200 — never blocks the page.
const trackView = async (req, res) => {
  try {
    const { slug } = req.params;
    const userId = req.auth && req.auth.user_id;

    if (!userId || !slug) {
      return res.status(200).json({ success: true });
    }

    const venue = await Venue.findOne({ slug }).select("_id");
    if (!venue) {
      return res.status(200).json({ success: true });
    }

    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    const recent = await VenueView.findOne({
      userId,
      venueId: venue._id,
      viewedAt: { $gte: thirtyMinutesAgo },
    }).select("_id");

    if (recent) {
      return res.status(200).json({ success: true });
    }

    await VenueView.create({
      userId,
      venueId: venue._id,
      venueSlug: slug,
      viewedAt: now,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(200).json({ success: true });
  }
};

module.exports = { trackView };

/**
 * controllers/venueAuspiciousDates.js — the venue-side READ of the muhurat
 * calendar (S1 consumption surface).
 *
 * Deliberately on the EXISTING venue-owner-auth surface rather than a new
 * public route: the data is not secret, but an unauthenticated endpoint is a
 * new thing to rate-limit, cache and abuse, and every consumer that needs it
 * today (owner portal calendar, demand map, lead date pickers) already holds a
 * venue token.
 *
 * NO capability gate. Whether a date is auspicious is neutral calendar
 * reference data with no lead, money or guest information in it — gating it
 * behind `leads` would blank the calendar for a front-desk member who is
 * looking at the very same dates. The venue boundary (this token belongs to
 * this venue) is the only check that means anything here.
 *
 * The venue's region is resolved server-side from the venue record, so no
 * caller has to know the resolution rule or can spoof a region to see another
 * region's dates.
 */
const Venue = require("../models/Venue");
const { lookupRange, venueRegions, toDayKey } = require("../utils/auspiciousDates");
const { venueDateKey, addVenueDays } = require("../utils/venueTime");

// A year plus a month of slack — enough for a full-year calendar in one call,
// small enough that nobody range-scans the whole collection through this route.
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 120;

// GET /venues/:slug/auspicious-dates?from=YYYY-MM-DD&to=YYYY-MM-DD
const getVenueAuspiciousDates = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id state city").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { from, to } = req.query || {};
    // Default window: today forward, in the venue's IST day — the same "today"
    // every other venue surface uses.
    const now = new Date();
    const fromKey = from ? toDayKey(from) : venueDateKey(now);
    if (!fromKey) return res.status(400).json({ message: "from must be a YYYY-MM-DD date" });
    const toKey = to ? toDayKey(to) : venueDateKey(addVenueDays(now, DEFAULT_RANGE_DAYS));
    if (!toKey) return res.status(400).json({ message: "to must be a YYYY-MM-DD date" });
    if (toKey < fromKey) return res.status(400).json({ message: "to must not be before from" });

    const spanDays = Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);
    if (spanDays > MAX_RANGE_DAYS) {
      return res.status(400).json({ message: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    }

    const regions = venueRegions(venue);
    const found = await lookupRange({ from: fromKey, to: toKey, region: regions });

    // An ARRAY, sorted, plus a bare key list. The array carries tier/notes for
    // a date detail; `keys` is what a calendar actually needs to colour a grid
    // without walking the array per cell.
    const dates = [...found.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return res.status(200).json({
      from: fromKey,
      to: toKey,
      regions,
      dates,
      keys: dates.map((d) => d.date),
      total: dates.length,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getVenueAuspiciousDates, MAX_RANGE_DAYS, DEFAULT_RANGE_DAYS };

/**
 * controllers/adminVenueAvailability.js — MB-V2 P0 S3: the Wedsy-side view of
 * E2 date-inventory. READ-ONLY: the day-board (cross-venue per-date states +
 * demand heat) and the cross-venue holds tracker. Hold REQUESTS are created
 * through the existing POST /venues/:slug/holds (admin token = wedsy-side
 * concierge request); approval stays with the owner per D3 — no admin
 * approve/decline/release/convert exists on purpose.
 */
const Venue = require("../models/Venue");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueEnquiry = require("../models/VenueEnquiry");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

// GET /admin/venues/day-board?date=YYYY-MM-DD[&zone=]
const dayBoard = async (req, res) => {
  try {
    const { date, zone } = req.query;
    if (!date || !ISO_DATE_RE.test(String(date))) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    // Same convention as the hold engine: dates are UTC-midnight Date rows.
    const day = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ message: "date is not a valid date" });
    const dayEnd = new Date(day.getTime() + 86399999);

    const venueFilter = {};
    if (zone) venueFilter.zone = String(zone).slice(0, 40);

    const [venues, stateRows, pendingRows, demandRows] = await Promise.all([
      Venue.find(venueFilter)
        .select("name slug zone city status spaces blockedDates")
        .lean(),
      VenueSpaceDate.aggregate([
        { $match: { date: day } },
        { $group: { _id: { venue: "$venue", state: "$state" }, n: { $sum: 1 } } },
      ]),
      VenueHold.aggregate([
        { $match: { status: "requested", dates: day } },
        { $group: { _id: "$venue", n: { $sum: 1 } } },
      ]),
      VenueEnquiry.aggregate([
        { $match: { stage: { $ne: "lost" }, eventDate: { $gte: day, $lte: dayEnd } } },
        { $group: { _id: "$venueId", n: { $sum: 1 } } },
      ]),
    ]);

    const states = {};
    for (const r of stateRows) {
      const key = String(r._id.venue);
      states[key] = states[key] || { held: 0, booked: 0, blocked: 0 };
      if (states[key][r._id.state] !== undefined) states[key][r._id.state] = r.n;
    }
    const pending = Object.fromEntries(pendingRows.map((r) => [String(r._id), r.n]));
    const demand = Object.fromEntries(demandRows.map((r) => [String(r._id), r.n]));

    let totalDemand = 0;
    let totalPending = 0;
    const board = venues.map((v) => {
      const key = String(v._id);
      const s = states[key] || { held: 0, booked: 0, blocked: 0 };
      const bookableSpaces = (v.spaces || []).filter((sp) => sp.isBookable !== false).length;
      const legacyBlocked = (v.blockedDates || []).includes(date);
      const claimedCount = s.held + s.booked + s.blocked;
      const d = demand[key] || 0;
      const p = pending[key] || 0;
      totalDemand += d;
      totalPending += p;
      return {
        _id: v._id,
        name: v.name,
        slug: v.slug,
        zone: v.zone || "",
        city: v.city || "",
        status: v.status,
        spacesTotal: bookableSpaces,
        held: s.held,
        booked: s.booked,
        blocked: s.blocked,
        legacyBlocked,
        // venue-wide holds claim every bookable space, so open never dips below 0
        open: Math.max(0, bookableSpaces - claimedCount),
        pendingHolds: p,
        demand: d,
      };
    });

    return res.status(200).json({
      date,
      venues: board,
      totals: { demand: totalDemand, pendingHolds: totalPending, venues: board.length },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /admin/venues/holds?status=&requestedBy=&slug=&limit=&skip=
// Cross-venue hold tracker — release/convert/decline visibility lives here
// (those transitions are owner actions; the admin just watches the status).
const listHoldsAdmin = async (req, res) => {
  try {
    const filter = {};
    const { status, requestedBy, slug } = req.query;
    if (status) {
      const statuses = String(status).split(",").map((s) => s.trim()).filter(Boolean);
      const allowed = VenueHold.schema.path("status").enumValues;
      if (statuses.some((s) => !allowed.includes(s))) {
        return res.status(400).json({ message: "Unknown hold status filter" });
      }
      filter.status = { $in: statuses };
    }
    if (requestedBy) {
      if (!VenueHold.schema.path("requestedBy").enumValues.includes(requestedBy)) {
        return res.status(400).json({ message: "Unknown requestedBy filter" });
      }
      filter.requestedBy = requestedBy;
    }
    if (slug) {
      const venue = await Venue.findOne({ slug: String(slug) }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venue = venue._id;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [holds, total] = await Promise.all([
      VenueHold.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug zone")
        .populate("linkedEnquiry", "coupleName couplePhone stage")
        .lean(),
      VenueHold.countDocuments(filter),
    ]);
    return res.status(200).json({ holds, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { dayBoard, listHoldsAdmin };

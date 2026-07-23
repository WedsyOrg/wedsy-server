/**
 * controllers/venueCrmDates.js — MB-CRM S6 demand map (one aggregation).
 *
 * Reuses existing inventory — creates NO new models:
 *   contested       — VenueEnquiry grouped by event date (checkIn||eventDate),
 *                     stage != lost/booked, count > 1 and not already booked
 *   held / expiring  — active VenueHold ({status,expiresAt}) with a live countdown
 *   booked           — VenueEnquiry stage=booked + VenueSpaceDate state=booked
 *   open inventory   — near-term dates with no demand, no hold, no booking
 * Competing lead NAMES are only revealed to leads_view_all; counts are shown to
 * everyone (aggregate contention, no PII).
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const { hasCapability } = require("../utils/venueRbac");

const DAY = 24 * 60 * 60 * 1000;
const OPEN_SCAN_DAYS = 120;
const dayKey = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};
const leadName = (l) => l.coupleName || l.name || "Lead";

// GET /venues/:slug/crm/dates
const getDemandMap = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const canViewAll = await hasCapability(req.venueOwner, "leads_view_all", req.venueMember);
    const now = new Date();

    const leads = await VenueEnquiry.find({ venueId: venue._id, stage: { $ne: "lost" } })
      .select("coupleName name checkIn eventDate stage")
      .lean();

    // demand (non-booked) grouped by date; booked leads → booked dates w/ names
    const demand = new Map(); // key -> [{_id,name}]
    const bookedByDate = new Map(); // key -> couple name
    for (const l of leads) {
      const key = dayKey(l.checkIn || l.eventDate);
      if (!key) continue;
      if (l.stage === "booked") {
        if (!bookedByDate.has(key)) bookedByDate.set(key, leadName(l));
        continue;
      }
      if (!demand.has(key)) demand.set(key, []);
      demand.get(key).push({ _id: l._id, name: leadName(l) });
    }

    // active holds (requested/approved, not expired)
    const holds = await VenueHold.find({ venue: venue._id, status: { $in: ["requested", "approved"] }, expiresAt: { $gt: now } })
      .populate("linkedEnquiry", "coupleName name")
      .lean();
    const heldDates = new Set();
    for (const h of holds) for (const d of h.dates || []) { const k = dayKey(d); if (k) heldDates.add(k); }

    // booked dates (space inventory + booked leads)
    const spaceBooked = await VenueSpaceDate.find({ venue: venue._id, state: "booked" }).select("date").lean();
    const bookedDates = new Set([...bookedByDate.keys()]);
    for (const s of spaceBooked) { const k = dayKey(s.date); if (k) bookedDates.add(k); }

    // ── contested ──
    const contested = [];
    for (const [key, arr] of demand) {
      if (arr.length > 1 && !bookedDates.has(key)) {
        contested.push({
          date: key,
          leadCount: arr.length,
          leads: canViewAll ? arr.slice(0, 3).map((x) => x.name) : [],
          hasHold: heldDates.has(key),
        });
      }
    }
    contested.sort((a, b) => b.leadCount - a.leadCount || a.date.localeCompare(b.date));

    // ── held / expiring (countdown) ──
    const held = holds
      .map((h) => {
        const primary = dayKey((h.dates || [])[0]);
        const daysLeft = Math.max(0, Math.ceil((new Date(h.expiresAt).getTime() - now.getTime()) / DAY));
        const couple = h.requestedByName || (h.linkedEnquiry && leadName(h.linkedEnquiry)) || "A couple";
        const competing = primary && demand.has(primary) ? demand.get(primary).length : 0;
        return { date: primary, dates: (h.dates || []).map(dayKey), daysLeft, couple, status: h.status, competingCount: Math.max(0, competing) };
      })
      .filter((h) => h.date)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    // ── booked ──
    const booked = [...bookedByDate.entries()].map(([date, couple]) => ({ date, couple })).sort((a, b) => a.date.localeCompare(b.date));

    // ── open inventory (near-term dates with no demand/hold/booking) ──
    const openSample = [];
    let openCount = 0;
    const startKey = dayKey(now);
    for (let i = 0; i < OPEN_SCAN_DAYS; i++) {
      const k = dayKey(new Date(now.getTime() + i * DAY));
      if (k === startKey && i > 0) continue;
      if (!demand.has(k) && !heldDates.has(k) && !bookedDates.has(k)) {
        openCount++;
        if (openSample.length < 8) openSample.push(k);
      }
    }

    return res.status(200).json({
      scoped: !canViewAll,
      contested,
      held,
      booked,
      openInventory: { count: openCount, windowDays: OPEN_SCAN_DAYS, sample: openSample },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getDemandMap };

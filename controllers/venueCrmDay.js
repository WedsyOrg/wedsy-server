/**
 * controllers/venueCrmDay.js — BUILD3 S1b. Everything happening on ONE date.
 *
 * The canonical answer to "what is going on for 26 Nov?", so the lead page
 * never has to grow its own mini-calendar and the two can never disagree.
 *
 * Reuses rather than duplicates:
 *   utils/venueContention  — the same day/stage maths the lead read uses
 *   utils/venueLeadScope   — every lead ROW goes through the scoped filter
 *   utils/auspiciousDates  — the live muhurat helper; the rule is NOT
 *                            re-derived here (region resolution included)
 *   VenueHold / VenueBooking / VenueSiteVisit — existing inventory, read as-is
 *
 * SCOPING. `leads[]` contains only leads this requester could already open by
 * id — a row they cannot open must not appear at all rather than appear and
 * fail. `hiddenCount` reports how many further non-terminal leads want the day,
 * so the total still matches the count on the lead page without naming anyone.
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const VenueBooking = require("../models/VenueBooking");
const VenueSiteVisit = require("../models/VenueSiteVisit");
const { canViewAllLeads, scopedLeadFilter } = require("../utils/venueLeadScope");
const { leadDays, leadsOnDays, summarise, approximateMonthDemand, monthKeyOfDay, blockBucket, blockHours } = require("../utils/venueContention");
const { venueDateKey, venueDayStartFromKey, addVenueDays } = require("../utils/venueTime");
const { lookupRange, venueRegions, toDayKey } = require("../utils/auspiciousDates");

const leadName = (l) => l.coupleName || l.name || "Lead";

// GET /venues/:slug/crm/day?date=YYYY-MM-DD&from=<enquiryId>
const getDay = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id state city").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const dayKey = toDayKey(req.query.date);
    if (!dayKey) return res.status(400).json({ message: "date must be a YYYY-MM-DD date" });
    const fromId = (req.query.from || "").trim();

    const canViewAll = await canViewAllLeads(req.venueOwner, req.venueMember);

    // Venue-wide occupancy for the aggregate (count + furthest stage)…
    const all = await leadsOnDays(venue._id, [dayKey], null);
    const summary = summarise([dayKey], all);

    // …and the SCOPED subset for the rows. Built by intersecting the venue-wide
    // ids with a scoped query rather than by filtering in JS, so the visibility
    // decision stays inside utils/venueLeadScope where it belongs.
    const visibleIds = new Set();
    if (all.length) {
      const scopedFilter = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id, {
        _id: { $in: all.map((l) => l._id) },
      });
      const visible = await VenueEnquiry.find(scopedFilter).select("_id").lean();
      for (const v of visible) visibleIds.add(String(v._id));
    }
    const visibleLeads = all.filter((l) => visibleIds.has(String(l._id)));

    // Site-visit status per visible lead (latest scheduled visit wins).
    const visitByLead = new Map();
    if (visibleLeads.length) {
      const visits = await VenueSiteVisit.find({ venue: venue._id, enquiryRef: { $in: visibleLeads.map((l) => l._id) } })
        .sort({ scheduledAt: -1 })
        .select("enquiryRef status scheduledAt")
        .lean();
      for (const v of visits) {
        const k = String(v.enquiryRef);
        if (!visitByLead.has(k)) visitByLead.set(k, { status: v.status, scheduledAt: v.scheduledAt });
      }
    }

    // Assignee names for the visible rows only.
    const assigneeNames = new Map();
    const assigneeIds = visibleLeads.map((l) => l.assignedTo).filter(Boolean);
    if (assigneeIds.length) {
      const VenueTeamMember = require("../models/VenueTeamMember");
      const members = await VenueTeamMember.find({ _id: { $in: assigneeIds } }).select("name").lean();
      for (const m of members) assigneeNames.set(String(m._id), m.name || "");
    }

    const leads = visibleLeads
      .map((l) => {
        const visit = visitByLead.get(String(l._id));
        return {
          _id: l._id,
          coupleName: leadName(l),
          checkIn: l.checkIn,
          checkOut: l.checkOut || null,
          stage: l.stage,
          quotedValue: l.estimatedValue || 0,
          siteVisitStatus: visit ? visit.status : null,
          siteVisitAt: visit ? visit.scheduledAt : null,
          assignedTo: l.assignedTo ? { _id: l.assignedTo, name: assigneeNames.get(String(l.assignedTo)) || "" } : null,
          // Lets the caller mark "this lead" so the owner does not lose their
          // place after arriving here from a workbench.
          isThisLead: Boolean(fromId) && String(l._id) === String(fromId),
          // A multi-day block is on this day but not only this day — worth
          // showing so a one-night enquiry is not confused with a four-day one.
          // Calendar days the block OCCUPIES — the venue is unavailable on all
          // of them, which is what this list is about.
          spansDays: leadDays(l).length,
          // …and what the couple actually ASKED for. A 21st-06:00 → 23rd-06:00
          // booking occupies three squares but is 48 hours, and the note on the
          // lead page says "2-day block". Sending both means the two surfaces
          // can stop disagreeing on screen without either of them lying.
          blockBucket: blockBucket(blockHours(l)),
          blockHours: blockHours(l),
        };
      })
      .sort((a, b) => Number(b.isThisLead) - Number(a.isThisLead) || b.quotedValue - a.quotedValue);

    // Hold + booking state for the date (existing inventory, read as-is).
    const dayStart = venueDayStartFromKey(dayKey);
    const dayEnd = addVenueDays(dayStart, 1);
    const [holds, bookingLead] = await Promise.all([
      VenueHold.find({
        venue: venue._id,
        status: { $in: ["requested", "approved"] },
        dates: { $gte: dayStart, $lt: dayEnd },
      })
        .select("_id status dates expiresAt space linkedEnquiry requestedByName")
        .lean(),
      VenueEnquiry.findOne({ venueId: venue._id, deleted: { $ne: true }, stage: "booked" })
        .where("checkIn")
        .gte(addVenueDays(dayStart, -8))
        .lt(dayEnd)
        .select("_id coupleName name checkIn checkOut")
        .lean(),
    ]);
    const bookedHere = bookingLead && leadDays(bookingLead).includes(dayKey) ? bookingLead : null;
    let booking = null;
    if (bookedHere) {
      const bk = await VenueBooking.findOne({ enquiry: bookedHere._id }).select("_id status").lean();
      // The couple's NAME on a booked date is lead PII, gated like every other
      // name here; the fact the date is gone is not.
      booking = {
        enquiryId: canViewAll || visibleIds.has(String(bookedHere._id)) ? bookedHere._id : undefined,
        coupleName: canViewAll || visibleIds.has(String(bookedHere._id)) ? leadName(bookedHere) : "A couple",
        bookingId: bk ? bk._id : null,
        status: bk ? bk.status : "confirmed",
      };
    }

    // Auspicious: ask the helper, never re-derive the rule or the region.
    const found = await lookupRange({ from: dayKey, to: dayKey, region: venueRegions(venue) });
    const auspiciousRow = found.get(dayKey) || null;

    // Month demand, still its own signal.
    const monthCount = await approximateMonthDemand(venue._id, monthKeyOfDay(dayKey), null);

    return res.status(200).json({
      date: dayKey,
      weekday: new Date(`${dayKey}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }),
      scoped: !canViewAll,
      // Venue-wide aggregate — matches what the lead page shows.
      total: summary.count,
      topStage: summary.topStage,
      // BUILD4 — what those enquiries actually want, split by block length.
      // Aggregate and PII-free, same classification as `total`, and the number
      // that lets an owner choose on revenue instead of on who asked first.
      blocks: summary.blocks,
      leads,
      // Non-terminal leads on this day the requester may not open. Named
      // nowhere; counted so the total still adds up.
      hiddenCount: Math.max(0, all.length - visibleLeads.length),
      holds: holds.map((h) => ({
        _id: h._id,
        status: h.status,
        expiresAt: h.expiresAt,
        space: h.space,
        linkedEnquiry: canViewAll || visibleIds.has(String(h.linkedEnquiry)) ? h.linkedEnquiry : undefined,
        couple: canViewAll || visibleIds.has(String(h.linkedEnquiry)) ? h.requestedByName || "A couple" : "A couple",
      })),
      booking,
      auspicious: auspiciousRow ? { tier: auspiciousRow.tier || null, notes: auspiciousRow.notes || "" } : null,
      approximateDemand: monthCount > 0 ? { month: monthKeyOfDay(dayKey), count: monthCount } : null,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getDay };

const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const { optStr } = require("../utils/venueInput");
const { notifyHoldRequested } = require("../utils/venueHoldAlert");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HOLD_DATES = 31;

// UTC-midnight Date from "YYYY-MM-DD"; null when malformed.
function parseDay(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}
const dayKey = (d) => d.toISOString().slice(0, 10);

// Slug → venue with ownership check. Admin tokens (req.admin) pass ownership
// by definition (wedsy-side hold creation is admin-gated at the route).
async function resolveVenue(req, res, select = "_id name slug spaces settings blockedDates contact phone") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (!req.admin && String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

function bookableSpaces(venue) {
  return (venue.spaces || []).filter((s) => s.isBookable !== false);
}

// Validate a dates payload → sorted unique UTC-midnight Dates (or null).
function parseDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0 || dates.length > MAX_HOLD_DATES) return null;
  const parsed = dates.map(parseDay);
  if (parsed.some((d) => !d)) return null;
  const uniq = [...new Map(parsed.map((d) => [d.getTime(), d])).values()];
  return uniq.sort((a, b) => a - b);
}

// The spaces a hold claims: its one space, or every bookable space (venue-wide).
function targetSpaceIds(venue, hold) {
  if (hold.space) return [hold.space];
  return bookableSpaces(venue).map((s) => s._id);
}

// ── Holds ──

// POST /venues/:slug/holds — create a hold REQUEST (D3: never auto-granted).
// Route is adminOrVenueOwnerAuth: an admin token = wedsy-side concierge
// request; a venue token (availability capability) = owner-raised hold.
const createHold = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    const dates = parseDates(body.dates);
    if (!dates) return res.status(400).json({ message: `dates must be 1-${MAX_HOLD_DATES} YYYY-MM-DD strings` });

    let space;
    if (body.space !== undefined && body.space !== null && body.space !== "") {
      const match = (venue.spaces || []).find((s) => String(s._id) === String(body.space));
      if (!match) return res.status(400).json({ message: "Unknown space for this venue" });
      if (match.isBookable === false) return res.status(400).json({ message: "This space is not bookable" });
      space = match._id;
    }

    const notesV = optStr(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });
    const nameV = optStr(body.requestedByName, "requestedByName", 200);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });

    let linkedEnquiry;
    if (body.linkedEnquiry) {
      const enq = await VenueEnquiry.findOne({ _id: body.linkedEnquiry, venueId: venue._id }).select("_id").lean();
      if (!enq) return res.status(400).json({ message: "linkedEnquiry does not belong to this venue" });
      linkedEnquiry = enq._id;
    }

    const holdDays = (venue.settings && venue.settings.holdExpiryDays) || 5;
    const hold = await VenueHold.create({
      venue: venue._id,
      space,
      dates,
      requestedBy: req.admin ? "wedsy" : "owner",
      requestedByName: nameV.value || (req.admin ? "Wedsy concierge" : ""),
      linkedEnquiry,
      notes: notesV.value,
      expiresAt: new Date(Date.now() + holdDays * 86400000),
    });

    // Owner gets a WhatsApp ping for wedsy-side requests (log-only default).
    if (req.admin) notifyHoldRequested(venue, hold).catch((e) => console.warn(`[holdAlert] ${e.message}`));

    // MB-V2 P3 notification mesh (log-only, fire-and-forget).
    require("../utils/venueNotify").notify({
      venue: venue._id,
      type: "hold_requested",
      title: `Hold requested — ${venue.name}`,
      body: `${hold.requestedBy === "wedsy" ? "Wedsy concierge" : "Owner"} requested ${hold.dates.length} date(s)`,
      meta: { holdId: hold._id, requestedBy: hold.requestedBy },
    });

    return res.status(201).json({ hold });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/holds?status=… — list holds (availability capability).
const listHolds = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const filter = { venue: venue._id };
    const status = (req.query.status || "").trim();
    if (status) {
      const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.some((s) => !VenueHold.schema.path("status").enumValues.includes(s))) {
        return res.status(400).json({ message: "Unknown hold status filter" });
      }
      filter.status = { $in: statuses };
    }
    const holds = await VenueHold.find(filter).sort({ createdAt: -1 }).limit(200).populate("linkedEnquiry", "coupleName couplePhone stage").lean();
    return res.status(200).json({ holds, total: holds.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

function actorName(req) {
  return req.admin ? "Wedsy admin" : (req.venueOwner && (req.venueOwner.name || (req.venueOwner.memberId ? "team member" : "owner"))) || "";
}

// POST /venues/:slug/holds/:holdId/approve — owner approval writes the held
// SpaceDate rows atomically (unique-index guard; all-or-nothing).
const approveHold = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const hold = await VenueHold.findOne({ _id: req.params.holdId, venue: venue._id });
    if (!hold) return res.status(404).json({ message: "Hold not found" });
    if (hold.status !== "requested") return res.status(409).json({ message: `Hold is ${hold.status}, not requested` });
    if (hold.expiresAt < new Date()) return res.status(409).json({ message: "Hold request has expired" });

    // Legacy venue-wide blocked dates win: approving over one is a conflict.
    const legacyBlocked = (venue.blockedDates || []).filter((s) => hold.dates.some((d) => dayKey(d) === s));
    if (legacyBlocked.length > 0) {
      return res.status(409).json({ message: `Date(s) blocked on the venue calendar: ${legacyBlocked.join(", ")}` });
    }

    const spaceIds = targetSpaceIds(venue, hold);
    if (spaceIds.length === 0) return res.status(400).json({ message: "Venue has no bookable spaces" });

    const rows = [];
    for (const s of spaceIds) for (const d of hold.dates) rows.push({ venue: venue._id, space: s, date: d, state: "held", holdRef: hold._id });
    try {
      await VenueSpaceDate.insertMany(rows, { ordered: true });
    } catch (e) {
      await VenueSpaceDate.deleteMany({ holdRef: hold._id });
      if (e.code === 11000) {
        return res.status(409).json({ message: "One or more space-dates are already held, booked, or blocked" });
      }
      throw e;
    }

    hold.status = "approved";
    hold.decidedAt = new Date();
    hold.decidedBy = actorName(req);
    await hold.save();
    return res.status(200).json({ hold, claimed: rows.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/holds/:holdId/decline — requested → declined.
const declineHold = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const hold = await VenueHold.findOne({ _id: req.params.holdId, venue: venue._id });
    if (!hold) return res.status(404).json({ message: "Hold not found" });
    if (hold.status !== "requested") return res.status(409).json({ message: `Hold is ${hold.status}, not requested` });
    hold.status = "declined";
    hold.decidedAt = new Date();
    hold.decidedBy = actorName(req);
    const notesV = optStr((req.body || {}).notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });
    if (notesV.value) hold.notes = hold.notes ? `${hold.notes}\n${notesV.value}` : notesV.value;
    await hold.save();
    return res.status(200).json({ hold });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/holds/:holdId/release — approved → released; frees rows.
const releaseHold = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const hold = await VenueHold.findOne({ _id: req.params.holdId, venue: venue._id });
    if (!hold) return res.status(404).json({ message: "Hold not found" });
    if (hold.status !== "approved") return res.status(409).json({ message: `Hold is ${hold.status}, not approved` });
    await VenueSpaceDate.deleteMany({ holdRef: hold._id, state: "held" });
    hold.status = "released";
    hold.decidedAt = new Date();
    hold.decidedBy = actorName(req);
    await hold.save();
    return res.status(200).json({ hold });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/holds/:holdId/convert — approved → converted; flips the
// held rows to booked against a real venue booking, atomically (a partial flip
// is impossible: rows are keyed by holdRef and flipped in one updateMany).
const convertHold = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const hold = await VenueHold.findOne({ _id: req.params.holdId, venue: venue._id });
    if (!hold) return res.status(404).json({ message: "Hold not found" });
    if (hold.status !== "approved") return res.status(409).json({ message: `Hold is ${hold.status}, not approved` });

    const { bookingId } = req.body || {};
    const booking = bookingId ? await VenueBooking.findOne({ _id: bookingId, venue: venue._id }).select("_id").lean() : null;
    if (!booking) return res.status(400).json({ message: "bookingId must reference a booking of this venue" });

    const flip = await VenueSpaceDate.updateMany(
      { holdRef: hold._id, state: "held" },
      { $set: { state: "booked", bookingRef: booking._id } }
    );
    hold.status = "converted";
    hold.decidedAt = new Date();
    hold.decidedBy = actorName(req);
    await hold.save();
    return res.status(200).json({ hold, converted: flip.modifiedCount });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Owner manual block / unblock ──

// POST /venues/:slug/calendar/block — {space?, dates[], notes?}
const blockDates = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    const dates = parseDates(body.dates);
    if (!dates) return res.status(400).json({ message: `dates must be 1-${MAX_HOLD_DATES} YYYY-MM-DD strings` });
    const notesV = optStr(body.notes, "notes", 2000);
    if (!notesV.ok) return res.status(400).json({ message: notesV.message });

    let spaceIds;
    if (body.space !== undefined && body.space !== null && body.space !== "") {
      const match = (venue.spaces || []).find((s) => String(s._id) === String(body.space));
      if (!match) return res.status(400).json({ message: "Unknown space for this venue" });
      spaceIds = [match._id];
    } else {
      spaceIds = bookableSpaces(venue).map((s) => s._id);
      if (spaceIds.length === 0) return res.status(400).json({ message: "Venue has no bookable spaces" });
    }

    const batchRef = new mongoose.Types.ObjectId();
    const rows = [];
    for (const s of spaceIds) for (const d of dates) rows.push({ venue: venue._id, space: s, date: d, state: "blocked", batchRef, notes: notesV.value });
    try {
      await VenueSpaceDate.insertMany(rows, { ordered: true });
    } catch (e) {
      await VenueSpaceDate.deleteMany({ batchRef });
      if (e.code === 11000) {
        return res.status(409).json({ message: "One or more space-dates are already held, booked, or blocked" });
      }
      throw e;
    }
    return res.status(201).json({ blocked: rows.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/calendar/unblock — removes ONLY blocked rows.
const unblockDates = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    const dates = parseDates(body.dates);
    if (!dates) return res.status(400).json({ message: `dates must be 1-${MAX_HOLD_DATES} YYYY-MM-DD strings` });
    const filter = { venue: venue._id, state: "blocked", date: { $in: dates } };
    if (body.space) filter.space = body.space;
    const del = await VenueSpaceDate.deleteMany(filter);
    return res.status(200).json({ unblocked: del.deletedCount });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Reads ──

function rangeFromQuery(req, res) {
  let from, to;
  const month = (req.query.month || "").trim();
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({ message: "month must be YYYY-MM" });
      return null;
    }
    from = parseDay(`${month}-01`);
    to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  } else {
    from = parseDay((req.query.from || "").trim());
    to = parseDay((req.query.to || "").trim());
    if (!from || !to || to < from) {
      res.status(400).json({ message: "Provide month=YYYY-MM or from/to as YYYY-MM-DD (to >= from)" });
      return null;
    }
    if ((to - from) / 86400000 > 92) {
      res.status(400).json({ message: "Range too large (max 92 days)" });
      return null;
    }
  }
  return { from, to };
}

// GET /venues/:slug/calendar/demand — per-date active-lead counts (non-lost
// leads by eventDate). The heat layer under the owner calendar.
const demandHeat = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res, "_id slug");
    if (!venue) return;
    const range = rangeFromQuery(req, res);
    if (!range) return;
    const rows = await VenueEnquiry.aggregate([
      { $match: { venueId: venue._id, deleted: { $ne: true }, stage: { $ne: "lost" }, eventDate: { $gte: range.from, $lte: new Date(range.to.getTime() + 86399999) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$eventDate" } }, leads: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return res.status(200).json({ demand: rows.map((r) => ({ date: r._id, leads: r.leads })) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/calendar?month=YYYY-MM (or from/to) — the merged owner
// calendar: per-day space states (SpaceDate) + legacy venue-wide blocks +
// demand heat + scheduled site visits + the day's pending hold requests.
const getCalendar = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const range = rangeFromQuery(req, res);
    if (!range) return;
    const toEnd = new Date(range.to.getTime() + 86399999);

    const [rows, holds, demand, visits] = await Promise.all([
      VenueSpaceDate.find({ venue: venue._id, date: { $gte: range.from, $lte: range.to } }).lean(),
      VenueHold.find({ venue: venue._id, status: "requested", expiresAt: { $gte: new Date() }, dates: { $elemMatch: { $gte: range.from, $lte: range.to } } })
        // match excludes soft-deleted leads: a lead deleted after a hold was placed
        // must not surface its coupleName/stage here (holds don't release on delete,
        // so the populate nulls the link instead). Mirrors listTasks.
        .populate({ path: "linkedEnquiry", select: "coupleName stage", match: { deleted: { $ne: true } } })
        .lean(),
      VenueEnquiry.aggregate([
        { $match: { venueId: venue._id, deleted: { $ne: true }, stage: { $ne: "lost" }, eventDate: { $gte: range.from, $lte: toEnd } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$eventDate" } }, leads: { $sum: 1 } } },
      ]),
      VenueEnquiry.find({ venueId: venue._id, deleted: { $ne: true }, stage: "site_visit_scheduled", followUpDate: { $gte: range.from, $lte: toEnd } })
        .select("coupleName followUpDate")
        .lean(),
    ]);

    const demandByDay = new Map(demand.map((d) => [d._id, d.leads]));
    const rowsByDay = new Map();
    for (const r of rows) {
      const k = dayKey(r.date);
      if (!rowsByDay.has(k)) rowsByDay.set(k, []);
      rowsByDay.get(k).push({ space: r.space, state: r.state, holdRef: r.holdRef, bookingRef: r.bookingRef, notes: r.notes });
    }
    const visitsByDay = new Map();
    for (const v of visits) {
      const k = dayKey(v.followUpDate);
      if (!visitsByDay.has(k)) visitsByDay.set(k, []);
      visitsByDay.get(k).push({ enquiry: v._id, coupleName: v.coupleName });
    }
    const holdsByDay = new Map();
    for (const h of holds) {
      for (const d of h.dates) {
        const k = dayKey(d);
        if (k < dayKey(range.from) || k > dayKey(range.to)) continue;
        if (!holdsByDay.has(k)) holdsByDay.set(k, []);
        holdsByDay.get(k).push({ hold: h._id, space: h.space || null, requestedBy: h.requestedBy, requestedByName: h.requestedByName, expiresAt: h.expiresAt, linkedEnquiry: h.linkedEnquiry || null });
      }
    }

    const legacyBlocked = new Set(venue.blockedDates || []);
    const days = [];
    for (let t = range.from.getTime(); t <= range.to.getTime(); t += 86400000) {
      const k = dayKey(new Date(t));
      days.push({
        date: k,
        venueBlocked: legacyBlocked.has(k),
        spaces: rowsByDay.get(k) || [],
        pendingHolds: holdsByDay.get(k) || [],
        demand: demandByDay.get(k) || 0,
        visits: visitsByDay.get(k) || [],
      });
    }
    return res.status(200).json({
      from: dayKey(range.from),
      to: dayKey(range.to),
      spaces: bookableSpaces(venue).map((s) => ({ _id: s._id, name: s.name, type: s.type, capacitySeated: s.capacitySeated })),
      days,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/calendar/settings — {holdExpiryDays} (availability cap).
const updateCalendarSettings = async (req, res) => {
  try {
    const venue = await resolveVenue(req, res);
    if (!venue) return;
    const { holdExpiryDays } = req.body || {};
    const n = Number(holdExpiryDays);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return res.status(400).json({ message: "holdExpiryDays must be an integer between 1 and 60" });
    }
    await Venue.updateOne({ _id: venue._id }, { $set: { "settings.holdExpiryDays": n } });
    return res.status(200).json({ success: true, holdExpiryDays: n });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createHold,
  listHolds,
  approveHold,
  declineHold,
  releaseHold,
  convertHold,
  blockDates,
  unblockDates,
  demandHeat,
  getCalendar,
  updateCalendarSettings,
};

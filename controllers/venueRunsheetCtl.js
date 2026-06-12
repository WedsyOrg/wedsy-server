/**
 * controllers/venueRunsheetCtl.js — Phase 5 (PMS) event-day runsheet CRUD +
 * reorder. Items belong to (booking, day); writes are leads-gated at the
 * route; vendor lines may carry vendorPhone for wa.me links.
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueRunsheetItem = require("../models/VenueRunsheetItem");
const { reqStr, optStr, optDate } = require("../utils/venueInput");
const { dayKey } = require("../utils/venueRunsheet");

const CATEGORIES = ["setup", "ceremony", "catering", "vendor", "teardown", "other"];
const STATUSES = ["pending", "in_progress", "done"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

function validateItemInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const v = reqStr(body.title, "title", 300);
    if (!v.ok) return { error: v.message };
    out.title = v.value;
  }
  if (body.time !== undefined) {
    const t = String(body.time || "").trim();
    if (t && !TIME_RE.test(t)) return { error: "time must be HH:MM (24h)" };
    out.time = t;
  }
  if (body.owner !== undefined) {
    const v = optStr(body.owner, "owner", 200);
    if (!v.ok) return { error: v.message };
    out.owner = v.value;
  }
  if (body.vendorPhone !== undefined) {
    const v = optStr(body.vendorPhone, "vendorPhone", 30);
    if (!v.ok) return { error: v.message };
    out.vendorPhone = v.value;
  }
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: `category must be one of: ${CATEGORIES.join(", ")}` };
    out.category = body.category;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { error: `status must be one of: ${STATUSES.join(", ")}` };
    out.status = body.status;
  }
  if (body.notes !== undefined) {
    const v = optStr(body.notes, "notes", 2000);
    if (!v.ok) return { error: v.message };
    out.notes = v.value;
  }
  return { value: out };
}

// GET /venues/:slug/bookings/:bookingId/runsheet?day=YYYY-MM-DD — open read.
const listRunsheet = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const query = { venue: venue._id, booking: req.params.bookingId };
    if (req.query.day) {
      const v = optDate(req.query.day, "day");
      if (!v.ok || !v.value) return res.status(400).json({ message: v.message || "day is invalid" });
      query.day = dayKey(v.value);
    }
    const items = await VenueRunsheetItem.find(query).sort({ day: 1, order: 1, time: 1 }).lean();
    return res.status(200).json({ items });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/bookings/:bookingId/runsheet — leads capability.
const createItem = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id }).select("_id").lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const dayV = optDate((req.body || {}).day, "day");
    if (!dayV.ok || !dayV.value) return res.status(400).json({ message: dayV.message || "day is required" });
    const v = validateItemInput(req.body || {});
    if (v.error) return res.status(400).json({ message: v.error });
    const day = dayKey(dayV.value);
    const last = await VenueRunsheetItem.findOne({ booking: booking._id, day }).sort({ order: -1 }).select("order").lean();
    const item = await VenueRunsheetItem.create({
      ...v.value,
      venue: venue._id,
      booking: booking._id,
      day,
      order: last ? last.order + 1 : 0,
    });
    return res.status(201).json({ item });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/runsheet/:itemId — leads capability.
const updateItem = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const item = await VenueRunsheetItem.findOne({ _id: req.params.itemId, venue: venue._id });
    if (!item) return res.status(404).json({ message: "Runsheet item not found" });
    const v = validateItemInput(req.body || {}, { partial: true });
    if (v.error) return res.status(400).json({ message: v.error });
    Object.assign(item, v.value);
    await item.save();
    return res.status(200).json({ item });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// DELETE /venues/:slug/runsheet/:itemId — leads capability.
const deleteItem = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const out = await VenueRunsheetItem.deleteOne({ _id: req.params.itemId, venue: venue._id });
    if (!out.deletedCount) return res.status(404).json({ message: "Runsheet item not found" });
    return res.status(200).json({ deleted: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/bookings/:bookingId/runsheet/reorder — leads capability.
// Body: { day: "YYYY-MM-DD", ids: [itemId, ...] } — order = array index.
const reorderRunsheet = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { ids } = req.body || {};
    const dayV = optDate((req.body || {}).day, "day");
    if (!dayV.ok || !dayV.value) return res.status(400).json({ message: dayV.message || "day is required" });
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
      return res.status(400).json({ message: "ids[] is required (max 200)" });
    }
    const day = dayKey(dayV.value);
    const items = await VenueRunsheetItem.find({ venue: venue._id, booking: req.params.bookingId, day }).select("_id").lean();
    const valid = new Set(items.map((i) => String(i._id)));
    if (!ids.every((id) => valid.has(String(id)))) {
      return res.status(400).json({ message: "ids must all belong to this booking day" });
    }
    await Promise.all(
      ids.map((id, idx) => VenueRunsheetItem.updateOne({ _id: id, venue: venue._id }, { $set: { order: idx } }))
    );
    const updated = await VenueRunsheetItem.find({ venue: venue._id, booking: req.params.bookingId, day })
      .sort({ order: 1 })
      .lean();
    return res.status(200).json({ items: updated });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { listRunsheet, createItem, updateItem, deleteItem, reorderRunsheet };

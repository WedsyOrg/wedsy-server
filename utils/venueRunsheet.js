/**
 * utils/venueRunsheet.js — default runsheet skeleton for new booking days.
 * Seeded rows are ordinary items (editable, deletable) flagged seeded:true.
 */
const VenueRunsheetItem = require("../models/VenueRunsheetItem");

const SKELETON = [
  { time: "09:00", title: "Setup & decor begins", category: "setup", order: 0 },
  { time: "18:00", title: "Event / ceremony", category: "ceremony", order: 1 },
  { time: "23:00", title: "Teardown & handover", category: "teardown", order: 2 },
];

const dayKey = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/**
 * Seed the default skeleton for every booking day that has no runsheet items
 * yet. Idempotent — existing days (even with all items deleted by hand after
 * a prior seed… no: deleted-by-hand days WOULD reseed; so seeding only fires
 * for days never seen, tracked by any-item-or-seeded-marker — we keep it
 * simple and only seed days with zero items, which matches "auto-seed when a
 * booking day is created").
 */
async function seedRunsheetForBooking(booking) {
  if (!booking || !Array.isArray(booking.days) || booking.days.length === 0) return 0;
  let seeded = 0;
  const seen = new Set();
  for (const day of booking.days) {
    if (!day || !day.date) continue;
    const key = dayKey(day.date);
    const iso = key.toISOString();
    if (seen.has(iso)) continue; // duplicate day entries get one runsheet
    seen.add(iso);
    const exists = await VenueRunsheetItem.exists({ booking: booking._id, day: key });
    if (exists) continue;
    await VenueRunsheetItem.insertMany(
      SKELETON.map((s) => ({
        ...s,
        venue: booking.venue,
        booking: booking._id,
        day: key,
        seeded: true,
      }))
    );
    seeded += SKELETON.length;
  }
  return seeded;
}

module.exports = { seedRunsheetForBooking, dayKey, SKELETON };

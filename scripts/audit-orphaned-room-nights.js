/**
 * scripts/audit-orphaned-room-nights.js
 *
 * Does any VenueRoomNight point at a room that no longer exists, or at one that
 * has been deactivated?
 *
 * Either is a room the booking engine has PROMISED and the property can no
 * longer supply. `deleteRoom` and `updateRoom` could both produce this — they
 * guarded on VenueRoomAllotment (a guest assigned) and never on VenueRoomNight
 * (a night claimed), and a booking that reserved a COUNT of rooms has the
 * second without the first. That is precisely the case ROOMS 1 exists to model.
 *
 * READ ONLY. Run against a restored copy; never against production directly.
 *
 *   DATABASE_URL=mongodb://127.0.0.1:27017/<restore> node scripts/audit-orphaned-room-nights.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueRoomNight = require("../models/VenueRoomNight");

(async () => {
  const url = process.env.DATABASE_URL || "";
  const host = (() => { try { return new URL(url.replace(/^mongodb\+srv:/, "https:").replace(/^mongodb:/, "http:")).hostname; } catch { return ""; } })();
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.error(`Refusing to run: "${host}" is not local. Restore a copy first.`);
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(url, { serverSelectionTimeoutMS: 10000 });
  console.log(`DB: ${mongoose.connection.name}\n`);

  const venues = await Venue.find({}).select("_id name slug rooms").lean();
  const roomsByVenue = new Map(venues.map((v) => [String(v._id), new Map((v.rooms || []).map((r) => [String(r._id), r]))]));
  const nameByVenue = new Map(venues.map((v) => [String(v._id), v.name || v.slug]));

  const nights = await VenueRoomNight.find({}).select("venue room night booking allotment").lean();
  const gone = [];
  const inactive = [];
  for (const n of nights) {
    const rooms = roomsByVenue.get(String(n.venue));
    if (!rooms) { gone.push({ n, why: "venue missing" }); continue; }
    const r = rooms.get(String(n.room));
    if (!r) gone.push({ n, why: "room deleted" });
    else if (r.isActive === false) inactive.push({ n, room: r });
  }

  console.log(`${venues.length} venue(s), ${nights.length} room-night row(s)`);
  console.log(`  rows whose room NO LONGER EXISTS : ${gone.length}`);
  console.log(`  rows whose room is DEACTIVATED   : ${inactive.length}`);

  const summarise = (list, label) => {
    if (!list.length) return;
    console.log(`\n${label}:`);
    const byBooking = new Map();
    for (const e of list) {
      const k = String(e.n.booking || "(no booking)");
      byBooking.set(k, (byBooking.get(k) || 0) + 1);
    }
    for (const [b, count] of byBooking) {
      console.log(`  booking ${b}: ${count} night(s) — venue ${nameByVenue.get(String(list[0].n.venue)) || "?"}`);
    }
  };
  summarise(gone, "ORPHANED — the room is gone");
  summarise(inactive, "ORPHANED — the room is deactivated");

  console.log(gone.length + inactive.length === 0
    ? "\n✓ nothing orphaned"
    : `\n✗ ${gone.length + inactive.length} orphaned room-night(s)`);

  await mongoose.disconnect();
})();

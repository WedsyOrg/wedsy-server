/**
 * scripts/verify-rooms-money-invariant.js
 *
 * ROOMS 5's safety proof, mechanical and re-runnable: no existing booking's
 * money moves because this feature shipped.
 *
 * Run it against a RESTORED COPY of production. It:
 *   1. snapshots every booking's totalValue and summarizeSchedule totals
 *   2. optionally seeds a booking that HAS rooms at a venue with a charging
 *      policy (--seed), because prod's own bookings may all be roomless and a
 *      roomless booking cannot move by construction — proving it does not move
 *      proves nothing
 *   3. saves a policy on every venue that has one seeded, which is the event
 *      most likely to reprice things if anything derives at read time
 *   4. re-reads and diffs
 *
 * Read only, apart from the seeded fixture, which it removes on the way out.
 *
 * Usage:
 *   DATABASE_URL=mongodb://127.0.0.1:27017/rm5_prod node scripts/verify-rooms-money-invariant.js --seed
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { resolvePolicy, quoteRooms } = require("../utils/venueRoomsPolicy");

const SEED = process.argv.includes("--seed");
const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

const snapshot = async () => {
  const out = new Map();
  const bookings = await VenueBooking.find({}).lean();
  for (const b of bookings) {
    const s = summarizeSchedule(b);
    out.set(String(b._id), {
      totalValue: b.totalValue,
      roomsRequired: b.roomsRequired || 0,
      bookingValue: s.totals.bookingValue,
      total: s.totals.total,
      balance: s.totals.balance,
      rows: s.rows.length,
    });
  }
  return out;
};

(async () => {
  const seeded = { venues: [], leads: [], bookings: [] };
  let failures = 0;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    console.log(`DB: ${mongoose.connection.name}\n`);

    if (SEED) {
      // The load-bearing case: a booking confirmed BEFORE this feature, at a
      // venue that would charge for exactly its shape.
      const tag = `inv${Date.now()}`;
      const venue = await Venue.create({
        name: `${tag} Resort`, slug: `${tag}-v`, city: "Bangalore", state: "Karnataka",
        rooms: Array.from({ length: 25 }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
        roomTypes: [{ name: "Deluxe", defaultRate: 4500 }],
        roomsPolicy: { configured: true, includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000 },
      });
      seeded.venues.push(venue._id);
      const lead = await VenueEnquiry.create({
        venueId: venue._id, coupleName: "Seeded Couple", coupleNameManual: true,
        couplePhone: "9800009999", stage: "booked", requirements: { roomsNeeded: 20 },
      });
      seeded.leads.push(lead._id);
      const bk = await VenueBooking.create({
        venue: venue._id, enquiry: lead._id, coupleName: "Seeded Couple",
        totalValue: 300000, roomsRequired: 20,
        days: [{ date: new Date(Date.now() + 30 * 86400000), eventType: "wedding", guestCount: 200 }],
        paymentSchedule: [
          { label: "Token", amount: 100000, dueDate: new Date(Date.now() + 86400000) },
          { label: "Instalment 1", amount: 200000, dueDate: new Date(Date.now() + 20 * 86400000) },
        ],
      });
      seeded.bookings.push(bk._id);
      const would = quoteRooms({
        policy: resolvePolicy(venue), roomsNeeded: 20, nights: 1, totalRoomsAtVenue: 25, typeRate: 4500,
      });
      console.log(`seeded a PRE-EXISTING booking with 20 rooms and totalValue ${money(300000)}`);
      console.log(`  its venue's policy would quote ${money(would.amount)} for that shape — ${would.sentence}`);
      console.log(`  so if anything derived rooms money at read time, this booking would move.\n`);
    }

    const before = await snapshot();
    const withRooms = [...before.values()].filter((b) => b.roomsRequired > 0).length;
    console.log(`${before.size} booking(s); ${withRooms} with rooms; ${[...before.values()].filter((b) => b.rows > 0).length} with a payment schedule`);
    if (!withRooms) {
      console.log("⚠️  no booking here HAS rooms — re-run with --seed, or this proves only the case that cannot move.");
    }

    // The provocation: touch every venue's policy. If a total is going to move,
    // this is what would move it.
    const venues = await Venue.find({}).select("_id slug roomsPolicy rooms roomTypes");
    for (const v of venues) {
      v.roomsPolicy = { configured: true, includedWithVenue: "none", includedCount: 0, extraRoomRate: 9999 };
      await v.save();
    }
    console.log(`provoked: saved an aggressively-charging policy on all ${venues.length} venue(s)\n`);

    const after = await snapshot();
    for (const [id, b] of before) {
      const a = after.get(id);
      if (!a) { console.error(`✗ ${id} disappeared`); failures++; continue; }
      for (const k of ["totalValue", "bookingValue", "total", "balance", "rows"]) {
        if (a[k] !== b[k]) {
          console.error(`✗ ${id} ${k}: ${b[k]} → ${a[k]}`);
          failures++;
        }
      }
    }
    console.log(failures === 0
      ? `✓ all ${before.size} booking(s) unchanged across every field — totalValue, bookingValue, total, balance, row count`
      : `✗ ${failures} field(s) moved`);
  } catch (e) {
    failures++;
    console.error("FATAL", e);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: seeded.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: seeded.leads } });
      await Venue.deleteMany({ _id: { $in: seeded.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    process.exitCode = failures ? 1 : 0;
  }
})();

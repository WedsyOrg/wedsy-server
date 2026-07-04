/**
 * scripts/seed-bulk-rows.js — volume fixtures for frontend virtualization
 * checks: bulk-inserts enquiries and/or bookings onto the seeded test venue
 * (test-palace) so the dashboard tables can be exercised at 5,000 rows.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a local Mongo host
 * (same guard as scripts/seed-test-venue.js). Inserted docs are tagged with
 * coupleName prefix "Bulk Row" so they're easy to identify/remove.
 *
 * Usage:
 *   node scripts/seed-bulk-rows.js --enquiries 5000 --bookings 5000
 *   node scripts/seed-bulk-rows.js --clean        # remove previous bulk rows
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const SLUG = "test-palace";

function argNum(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return 0;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20000) : 0;
}

function assertLocalMongo() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run: DATABASE_URL host "${host}" is not local.`);
  }
  return host;
}

const STAGES = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating"];
const BOOKING_STATUSES = ["confirmed", "in_progress", "completed"];

async function run() {
  const host = assertLocalMongo();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[seed-bulk] connected to local Mongo @ ${host}`);

  const venue = await Venue.findOne({ slug: SLUG }).select("_id").lean();
  if (!venue) throw new Error(`venue ${SLUG} not found — run seed-test-venue.js first`);

  if (process.argv.includes("--clean")) {
    const e = await VenueEnquiry.deleteMany({ venueId: venue._id, coupleName: /^Bulk Row/ });
    const b = await VenueBooking.deleteMany({ venue: venue._id, coupleName: /^Bulk Row/ });
    console.log(`[seed-bulk] cleaned ${e.deletedCount} enquiries, ${b.deletedCount} bookings`);
  }

  const nEnq = argNum("--enquiries");
  const nBook = argNum("--bookings");
  const now = Date.now();

  if (nEnq) {
    const docs = Array.from({ length: nEnq }, (_, i) => ({
      venueId: venue._id,
      coupleName: `Bulk Row Enq ${i + 1}`,
      couplePhone: String(6e9 + ((now + i) % 1e9)),
      stage: STAGES[i % STAGES.length],
      source: "other",
      estimatedValue: 50000 + (i % 50) * 1000,
      createdAt: new Date(now - (i % 365) * 86400000),
    }));
    for (let i = 0; i < docs.length; i += 1000) {
      await VenueEnquiry.insertMany(docs.slice(i, i + 1000), { ordered: false });
    }
    console.log(`[seed-bulk] inserted ${nEnq} enquiries`);
  }

  if (nBook) {
    const docs = Array.from({ length: nBook }, (_, i) => ({
      venue: venue._id,
      coupleName: `Bulk Row Bk ${i + 1}`,
      couplePhone: String(5e9 + ((now + i) % 1e9)),
      totalValue: 100000 + (i % 100) * 5000,
      status: BOOKING_STATUSES[i % BOOKING_STATUSES.length],
      days: [{ date: new Date(now + (i % 365) * 86400000), eventType: "Wedding", guestCount: 100 + (i % 400) }],
      createdAt: new Date(now - (i % 365) * 86400000),
    }));
    for (let i = 0; i < docs.length; i += 1000) {
      await VenueBooking.insertMany(docs.slice(i, i + 1000), { ordered: false });
    }
    console.log(`[seed-bulk] inserted ${nBook} bookings`);
  }

  console.log("[seed-bulk] DONE");
  process.exit(0);
}

run().catch((e) => {
  console.error("[seed-bulk] FATAL:", e.message);
  process.exit(1);
});

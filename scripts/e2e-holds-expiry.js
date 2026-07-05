/**
 * scripts/e2e-holds-expiry.js — DB-level checks for the D3 hold-expiry sweep.
 * Runs against local Mongo directly (like e2e-reviews-cache.js): seeds a venue
 * hold in each interesting state, invokes runHoldExpirySweep with a synthetic
 * "now", and asserts state transitions, freed rows, and the follow-up bump.
 *
 * Seed first with scripts/seed-test-venue.js. LOCAL Mongo only (env guard).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueEnquiry = require("../models/VenueEnquiry");
const { runHoldExpirySweep } = require("../utils/venueHoldExpiryJob");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ PASS  ${name}`); }
  else { fail++; console.log(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function run() {
  const host = new URL(process.env.DATABASE_URL || "").hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing: non-local Mongo host "${host}"`);
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });

  const venue = await Venue.findOne({ slug: "test-palace" }).select("_id spaces");
  if (!venue) throw new Error("Seed first: test-palace not found");
  const space = venue.spaces.find((s) => s.isBookable !== false);
  const day = (n) => new Date(Date.UTC(2031, 0, n)); // far future, collision-free
  const past = new Date(Date.now() - 3600000);
  const lead = await VenueEnquiry.findOne({ venueId: venue._id, stage: { $nin: ["booked", "lost"] } }).select("_id");

  // Fixtures: expired-approved (with rows + linked lead), expired-requested,
  // healthy-approved (must survive), already-converted (must survive).
  const expApproved = await VenueHold.create({ venue: venue._id, space: space._id, dates: [day(1)], requestedBy: "wedsy", status: "approved", expiresAt: past, linkedEnquiry: lead && lead._id });
  await VenueSpaceDate.create({ venue: venue._id, space: space._id, date: day(1), state: "held", holdRef: expApproved._id });
  const expRequested = await VenueHold.create({ venue: venue._id, space: space._id, dates: [day(2)], requestedBy: "owner", status: "requested", expiresAt: past });
  const healthy = await VenueHold.create({ venue: venue._id, space: space._id, dates: [day(3)], requestedBy: "wedsy", status: "approved", expiresAt: new Date(Date.now() + 86400000) });
  await VenueSpaceDate.create({ venue: venue._id, space: space._id, date: day(3), state: "held", holdRef: healthy._id });
  const converted = await VenueHold.create({ venue: venue._id, space: space._id, dates: [day(4)], requestedBy: "wedsy", status: "converted", expiresAt: past });
  if (lead) await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { followUpDate: new Date(Date.now() + 30 * 86400000) } });

  const result = await runHoldExpirySweep();
  ok("sweep expires overdue requested+approved holds", result.expired === 2, `expired=${result.expired}`);
  ok("sweep frees exactly the expired hold's rows", result.freedRows === 1, `freed=${result.freedRows}`);

  const a = await VenueHold.findById(expApproved._id).lean();
  const r = await VenueHold.findById(expRequested._id).lean();
  const h = await VenueHold.findById(healthy._id).lean();
  const c = await VenueHold.findById(converted._id).lean();
  ok("expired-approved -> expired", a.status === "expired", a.status);
  ok("expired-requested -> expired", r.status === "expired", r.status);
  ok("healthy approved untouched", h.status === "approved", h.status);
  ok("converted hold untouched (never expires)", c.status === "converted", c.status);

  const rowGone = await VenueSpaceDate.countDocuments({ holdRef: expApproved._id });
  const rowKept = await VenueSpaceDate.countDocuments({ holdRef: healthy._id });
  ok("expired hold's space-date rows deleted", rowGone === 0, `left=${rowGone}`);
  ok("healthy hold's rows intact", rowKept === 1, `kept=${rowKept}`);

  if (lead) {
    const l = await VenueEnquiry.findById(lead._id).select("followUpDate").lean();
    ok("linked lead follow-up pulled up to now (surfaces in queue)", l.followUpDate && l.followUpDate <= new Date(), String(l.followUpDate));
  }

  // Idempotence: second sweep is a no-op.
  const again = await runHoldExpirySweep();
  ok("second sweep is a no-op", again.expired === 0, `expired=${again.expired}`);

  // Cleanup fixtures.
  await VenueHold.deleteMany({ _id: { $in: [expApproved._id, expRequested._id, healthy._id, converted._id] } });
  await VenueSpaceDate.deleteMany({ holdRef: { $in: [expApproved._id, expRequested._id, healthy._id, converted._id] } });

  console.log(`\n[e2e-holds-expiry] ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => { console.error(`[e2e-holds-expiry] FAILED: ${err.message}`); process.exit(1); });

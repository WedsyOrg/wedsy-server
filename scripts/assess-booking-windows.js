/**
 * scripts/assess-booking-windows.js — ASSESSMENT ONLY. Never writes. Ever.
 *
 * Every booking made before the ONE-WINDOW change has no checkIn/checkOut, and
 * blocks only the days its functions happened to sit on. Under the new rule the
 * window is what is sold, so those bookings would GAIN calendar blocks for the
 * days inside their window that nobody claimed.
 *
 * That is the risky part, so this script does not carry an --apply flag at all.
 * There is nothing to type that makes it write. It answers three questions:
 *
 *   1. Can each booking's window be derived from its linked lead?
 *   2. Which date-spaces would it gain?
 *   3. Does any of those collide with a commitment that already exists — and
 *      if so, WHICH booking or hold, on which space, on which date?
 *
 * ── WHY IT REFUSES TO FORCE, BY CONSTRUCTION ────────────────────────────────
 * A collision means two real commitments overlap on a real date. One of those
 * couples is going to be told something. Which one, and what, is a conversation
 * a venue owner has — it is not a decision a migration script is entitled to
 * make, and "last writer wins" would silently pick a loser. So collisions are
 * reported and nothing is resolved.
 *
 * Usage:
 *   node scripts/assess-booking-windows.js                 # local
 *   ALLOW_REMOTE=1 node scripts/assess-booking-windows.js  # read prod, still read-only
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueBooking = require("../models/VenueBooking");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueHold = require("../models/VenueHold");
const Venue = require("../models/Venue");
const { windowDays, pairKey } = require("../utils/venueEventWindow");
const { venueDateKey, endOfVenueDay } = require("../utils/venueTime");

const TAG = "assess-booking-windows";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

// There is deliberately no --apply. If someone passes one, say so plainly
// rather than ignoring it — a silent no-op would read as "it ran".
if (process.argv.includes("--apply")) {
  console.error(
    `[${TAG}] This script has no --apply. It is assessment-only by design:\n` +
      "  a collision is two real commitments on one date, and choosing between\n" +
      "  them is a conversation with a couple, not a script's decision."
  );
  process.exit(2);
}

function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[${TAG}] ┌───────────────────────────────────────────`);
  console.log(`[${TAG}] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[${TAG}] │ MODE: READ-ONLY — this script cannot write`);
  console.log(`[${TAG}] └───────────────────────────────────────────`);
  if (!isLocal && !ALLOW_REMOTE) {
    throw new Error(`Refusing to read REMOTE host "${host}" without ALLOW_REMOTE=1`);
  }
  return host;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${TAG}] connected @ ${host}\n`);

  const bookings = await VenueBooking.find({})
    .select("_id venue enquiry coupleName checkIn checkOut days status")
    .lean();

  const venues = new Map(
    (await Venue.find({}).select("_id name slug spaces").lean()).map((v) => [String(v._id), v])
  );
  const spaceName = (venueId, spaceId) => {
    const v = venues.get(String(venueId));
    const s = v && (v.spaces || []).find((x) => String(x._id) === String(spaceId));
    return (s && s.name) || String(spaceId).slice(-6);
  };

  const summary = {
    total: bookings.length,
    alreadyHaveWindow: 0,
    derivable: 0,
    derivedFromDays: 0,
    underivable: 0,
    noCalendarRows: 0,
    wouldGainRows: 0,
    bookingsGaining: 0,
    collisions: 0,
    bookingsWithCollisions: 0,
  };
  const gaining = [];
  const collisions = [];
  const underivable = [];

  for (const b of bookings) {
    if (b.checkIn && b.checkOut) {
      summary.alreadyHaveWindow += 1;
      continue;
    }

    // 1. Can the window be derived?
    let checkIn = null;
    let checkOut = null;
    let source = "";
    const lead = b.enquiry ? await VenueEnquiry.findById(b.enquiry).select("checkIn checkOut datesFinalised coupleName").lean() : null;
    if (lead && lead.checkIn && lead.checkOut) {
      checkIn = lead.checkIn;
      checkOut = lead.checkOut;
      source = "lead window";
      summary.derivable += 1;
    } else if ((b.days || []).length) {
      // Fall back to the span of days[] — the same rule confirmBookingFromLead
      // uses when a lead has no finalised window. Honest, but it cannot invent
      // a check-in TIME, so it is reported separately.
      const sorted = (b.days || []).map((d) => d.date).filter(Boolean).sort((x, y) => new Date(x) - new Date(y));
      checkIn = new Date(sorted[0]);
      checkOut = endOfVenueDay(new Date(sorted[sorted.length - 1]));
      source = "days[] span (no lead window — times unknown)";
      summary.derivedFromDays += 1;
    } else {
      summary.underivable += 1;
      underivable.push({ _id: b._id, coupleName: b.coupleName, reason: lead ? "lead has no window and booking has no days" : "no linked lead and no days" });
      continue;
    }

    // 2. What would it gain?
    const rows = await VenueSpaceDate.find({ bookingRef: b._id }).select("space date").lean();
    if (!rows.length) {
      // No rows means no spaces can be derived — the booking never claimed
      // anything, so there is nothing to widen and nothing to collide with.
      summary.noCalendarRows += 1;
      continue;
    }
    const spaceIds = [...new Map(rows.map((r) => [String(r.space), r.space])).values()];
    const held = new Set(rows.map((r) => pairKey(r.space, r.date)));

    const wants = [];
    for (const day of windowDays(checkIn, checkOut)) {
      for (const sp of spaceIds) {
        if (!held.has(pairKey(sp, day))) wants.push({ space: sp, date: day });
      }
    }
    if (!wants.length) continue;

    summary.bookingsGaining += 1;
    summary.wouldGainRows += wants.length;

    // 3. Does any wanted row collide?
    const clash = await VenueSpaceDate.find({
      venue: b.venue,
      $or: wants.map((w) => ({ space: w.space, date: w.date })),
    })
      .select("space date state bookingRef holdRef")
      .lean();

    const mine = [];
    for (const c of clash) {
      if (String(c.bookingRef || "") === String(b._id)) continue;
      let other = { kind: "block", label: "a manual calendar block" };
      if (c.bookingRef) {
        const ob = await VenueBooking.findById(c.bookingRef).select("coupleName").lean();
        other = { kind: "booking", _id: c.bookingRef, label: `booking "${(ob && ob.coupleName) || "unnamed"}"` };
      } else if (c.holdRef) {
        const oh = await VenueHold.findById(c.holdRef).select("status linkedEnquiry").lean();
        other = { kind: "hold", _id: c.holdRef, label: `${(oh && oh.status) || "live"} hold` };
      }
      mine.push({
        venue: (venues.get(String(b.venue)) || {}).name || String(b.venue),
        space: spaceName(b.venue, c.space),
        day: venueDateKey(c.date),
        state: c.state,
        other,
      });
    }

    gaining.push({
      _id: b._id,
      coupleName: b.coupleName || (lead && lead.coupleName) || "(unnamed)",
      venue: (venues.get(String(b.venue)) || {}).name || String(b.venue),
      source,
      window: `${venueDateKey(checkIn)} → ${venueDateKey(checkOut)}`,
      gains: wants.length,
      gainDays: [...new Set(wants.map((w) => venueDateKey(w.date)))].sort(),
      spaces: spaceIds.map((s) => spaceName(b.venue, s)),
      collisions: mine,
    });
    if (mine.length) {
      summary.bookingsWithCollisions += 1;
      summary.collisions += mine.length;
      collisions.push(...mine.map((m) => ({ ...m, booking: b._id, coupleName: b.coupleName })));
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log("── SCANNED ────────────────────────────────────────");
  console.log(`   bookings ............................ ${summary.total}`);
  console.log(`   …already carry a window (no action) . ${summary.alreadyHaveWindow}`);
  console.log(`   …window derivable from the LEAD ..... ${summary.derivable}`);
  console.log(`   …only derivable from days[] span .... ${summary.derivedFromDays}  (check-in TIME unknown)`);
  console.log(`   …not derivable at all ............... ${summary.underivable}`);
  console.log(`   …hold no calendar rows (nothing to widen) ${summary.noCalendarRows}`);

  console.log("\n── WHAT WOULD CHANGE ──────────────────────────────");
  console.log(`   bookings that would GAIN blocks ..... ${summary.bookingsGaining}`);
  console.log(`   date-space rows they would gain ..... ${summary.wouldGainRows}`);

  console.log("\n── COLLISIONS ─────────────────────────────────────");
  console.log(`   bookings with at least one collision  ${summary.bookingsWithCollisions}`);
  console.log(`   colliding date-spaces ............... ${summary.collisions}`);
  if (collisions.length) {
    console.log("\n   Each line is TWO real commitments on one date. Nothing here can be");
    console.log("   resolved automatically — both sides are named so an owner can call.");
    for (const c of collisions.slice(0, 100)) {
      console.log(`   ✗ ${c.venue} · ${c.space} · ${c.day}`);
      console.log(`       wanted by : booking ${c.booking} "${c.coupleName || "(unnamed)"}"`);
      console.log(`       held by   : ${c.other.label}${c.other._id ? ` (${c.other._id})` : ""} — state "${c.state}"`);
    }
    if (collisions.length > 100) console.log(`   … and ${collisions.length - 100} more not listed`);
  } else {
    console.log("   none.");
  }

  if (gaining.length) {
    console.log("\n── PER BOOKING ────────────────────────────────────");
    for (const g of gaining.slice(0, 60)) {
      console.log(
        `   ${g.collisions.length ? "✗" : "·"} ${g._id} "${g.coupleName}" @ ${g.venue}` +
          `\n       window ${g.window}  (from ${g.source})` +
          `\n       spaces ${g.spaces.join(", ")}` +
          `\n       +${g.gains} row(s) on ${g.gainDays.join(", ")}` +
          (g.collisions.length ? `  ⟵ ${g.collisions.length} COLLISION(S)` : "")
      );
    }
    if (gaining.length > 60) console.log(`   … and ${gaining.length - 60} more not listed`);
  }

  if (underivable.length) {
    console.log("\n── NOT DERIVABLE ──────────────────────────────────");
    console.log("   These need a human to say what the dates were.");
    for (const u of underivable.slice(0, 40)) {
      console.log(`   ? ${u._id} "${u.coupleName || "(unnamed)"}" — ${u.reason}`);
    }
    if (underivable.length > 40) console.log(`   … and ${underivable.length - 40} more`);
  }

  console.log(`\n[${TAG}] READ-ONLY — nothing was written, and there is no flag that would.`);
  if (summary.collisions > 0) {
    console.log(`[${TAG}] ${summary.collisions} collision(s) must be settled with the couples involved before any backfill is designed.`);
  }
  await mongoose.disconnect();
  console.log(`[${TAG}] DONE`);
}

run().catch((err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  process.exit(1);
});

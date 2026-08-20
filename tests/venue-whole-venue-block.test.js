// ENTIRE PROPERTY — double-booking must be impossible, by the INDEX.
// Run: node tests/venue-whole-venue-block.test.js
//
// The representation: "entire property" is every bookable space claimed in one
// batch, PLUS a sentinel row. A sentinel ALONE would not work — {venue, WHOLE,
// D} and {venue, S1, D} are different index keys and do not collide, so that
// design stops two whole-venue bookings and nothing else, leaving
// whole-vs-individual to application logic. Exploding is what makes the
// collision structural.
//
// This suite proves both directions against the real unique index, and proves
// the backfill that closes the one hole exploding leaves: a space created after
// the property was sold.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const {
  WHOLE_VENUE_SPACE_ID,
  wholeVenueSpaceIds,
  backfillNewSpaceIntoWholeVenueBlocks,
} = require("../utils/venueWholeVenue");

const TAG = `whole-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const created = [];

const D = (n) => new Date(Date.UTC(2031, 5, n));

/** The house write: insertMany(ordered) and roll the batch back on collision. */
async function claim(venue, spaceIds, date, state = "booked") {
  const batchRef = new mongoose.Types.ObjectId();
  try {
    await VenueSpaceDate.insertMany(
      spaceIds.map((space) => ({ venue: venue._id, space, date, state, batchRef })),
      { ordered: true }
    );
    return { ok: true, batchRef };
  } catch (e) {
    await VenueSpaceDate.deleteMany({ batchRef });
    return { ok: false, code: e.code, batchRef };
  }
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }, { name: "Hall", isBookable: true }, { name: "Gazebo", isBookable: false }],
    });
    created.push(venue._id);
    const fresh = await Venue.findById(venue._id).lean();
    const [lawn, hall, gazebo] = fresh.spaces;

    console.log("\n[the spaces a whole-property claim covers]");
    const ids = wholeVenueSpaceIds(fresh).map(String);
    ok(ids.includes(String(lawn._id)) && ids.includes(String(hall._id)), "every BOOKABLE space is included");
    ok(!ids.includes(String(gazebo._id)), "a non-bookable space is NOT claimed — it was never sellable");
    ok(ids.includes(String(WHOLE_VENUE_SPACE_ID)), "…plus the sentinel");

    console.log("\n[A. individual space first, then the entire property]");
    ok((await claim(fresh, [lawn._id], D(1))).ok, "booking the Lawn on 1 Jun succeeds");
    const blockedWhole = await claim(fresh, wholeVenueSpaceIds(fresh), D(1));
    ok(!blockedWhole.ok && blockedWhole.code === 11000, "THE POINT: the entire property is refused by the INDEX, not a check");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, date: D(1) })) === 1,
      "…and the refused batch left nothing behind — no half-claimed date");

    console.log("\n[B. entire property first, then an individual space]");
    ok((await claim(fresh, wholeVenueSpaceIds(fresh), D(2))).ok, "booking the entire property on 2 Jun succeeds");
    ok(!(await claim(fresh, [lawn._id], D(2))).ok, "THE OTHER DIRECTION: the Lawn is refused");
    ok(!(await claim(fresh, [hall._id], D(2))).ok, "…and so is the Hall");
    ok(!(await claim(fresh, wholeVenueSpaceIds(fresh), D(2))).ok, "…and a second whole-property claim");

    console.log("\n[C. a venue with NO spaces — what the sentinel is for]");
    const bare = await Venue.create({ name: `${TAG}-bare`, slug: `${TAG}-bare`, spaces: [] });
    created.push(bare._id);
    const bareFresh = await Venue.findById(bare._id).lean();
    ok(wholeVenueSpaceIds(bareFresh).length === 1, "the claim is the sentinel alone");
    ok((await claim(bareFresh, wholeVenueSpaceIds(bareFresh), D(3))).ok, "the whole property can be sold with no spaces defined");
    ok(!(await claim(bareFresh, wholeVenueSpaceIds(bareFresh), D(3))).ok,
      "…and a second sale on that date is refused — without the sentinel there would be nothing to collide on");

    console.log("\n[D. a space added AFTER the property was sold — across MANY dates]");
    // Whole property sold on three separate future dates.
    const soldDates = [D(10), D(11), D(12)];
    for (const d of soldDates) ok((await claim(fresh, wholeVenueSpaceIds(fresh), d)).ok, `entire property sold on ${d.toISOString().slice(0, 10)}`);

    // Now the owner adds a space to their listing.
    await Venue.updateOne({ _id: venue._id }, { $push: { spaces: { name: "Terrace", isBookable: true } } });
    const withTerrace = await Venue.findById(venue._id).lean();
    const terrace = withTerrace.spaces.find((s) => s.name === "Terrace");

    const r = await backfillNewSpaceIntoWholeVenueBlocks(venue._id, terrace._id, {});
    // Every future date the property is already sold on — which includes the
    // one section B sold, not just the three above. "All affected dates" is the
    // assertion that matters, not a hardcoded three.
    const soldCount = await VenueSpaceDate.countDocuments({
      venue: venue._id, space: WHOLE_VENUE_SPACE_ID, date: { $gte: new Date() },
    });
    ok(r.dates === soldCount, `the backfill found ALL ${soldCount} affected dates, not just the latest`);
    ok(r.inserted === soldCount, "…and added the new space to every one of them");
    ok(r.ok, "…and reports success only when every date is covered");

    for (const d of soldDates) {
      ok(!(await claim(withTerrace, [terrace._id], d)).ok,
        `the new Terrace is refused on ${d.toISOString().slice(0, 10)} — the hole is closed`);
    }

    console.log("\n[E. the backfill never silently succeeds]");
    // One date already has a Terrace row; the rest do not. An ordered insert
    // would abandon the remainder — this must not.
    const partialDates = [D(20), D(21), D(22)];
    for (const d of partialDates) await claim(fresh, wholeVenueSpaceIds(fresh), d);
    const b2 = new mongoose.Types.ObjectId();
    await VenueSpaceDate.create({ venue: venue._id, space: terrace._id, date: D(21), state: "booked", batchRef: b2 });
    const r2 = await backfillNewSpaceIntoWholeVenueBlocks(venue._id, terrace._id, {});
    ok(r2.alreadyPresent >= 1, "a date already covered is counted as ALREADY PRESENT, not as a failure");
    ok(r2.failed.length === 0, "…nothing is reported as failed");
    ok(r2.ok, "…and the overall result is still ok, because every date IS covered");
    for (const d of partialDates) {
      ok((await VenueSpaceDate.countDocuments({ venue: venue._id, space: terrace._id, date: d })) === 1,
        `${d.toISOString().slice(0, 10)} has exactly one Terrace row — the unordered insert did not stop at the collision`);
    }

    console.log("\n[F. a date nobody sold is untouched]");
    ok((await claim(withTerrace, [terrace._id], D(28))).ok, "an unsold date is still freely bookable");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created) {
      await VenueSpaceDate.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

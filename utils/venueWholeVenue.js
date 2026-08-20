/**
 * utils/venueWholeVenue.js — booking the ENTIRE PROPERTY, guaranteed by the index.
 *
 * ══ THE REPRESENTATION ══════════════════════════════════════════════════════
 * "Entire property" is NOT a special kind of row. It is every bookable space
 * claimed in one batch, plus one sentinel row. No new index, no new collection,
 * no new state — the existing unique {venue, space, date} on VenueSpaceDate
 * does all the work, and the existing insertMany(ordered) → E11000 →
 * deleteMany({batchRef}) → 409 path handles it unchanged.
 *
 * ══ WHY A SENTINEL ALONE WOULD NOT WORK ═════════════════════════════════════
 * The obvious design is one row with a magic `space` value. It does not work,
 * and the reason is worth stating: a sentinel row {venue, WHOLE, D} and an
 * individual row {venue, S1, D} are DIFFERENT INDEX KEYS. They do not collide.
 * That design stops two whole-venue bookings and nothing else, leaving
 * whole-vs-individual to application logic — which is exactly the thing that
 * must not be trusted with a double-booking guarantee.
 *
 * Exploding is what makes the collision STRUCTURAL: the individual space's row
 * already exists, so the second claim fails on the index itself.
 *
 * ══ WHAT THE SENTINEL IS ACTUALLY FOR ═══════════════════════════════════════
 * Two things, neither of them "marking the block":
 *
 *   1. A venue with NO spaces defined. Exploding produces zero rows, so without
 *      the sentinel such a venue could take unlimited bookings on one date —
 *      and that venue is precisely the case this feature exists for. The
 *      sentinel is the only row there, and it collides with itself.
 *
 *   2. Making a whole-venue claim FINDABLE, so a space added later can be
 *      backfilled onto the dates the whole property was already sold for.
 *      See backfillNewSpaceIntoWholeVenueBlocks().
 */
const mongoose = require("mongoose");
const VenueSpaceDate = require("../models/VenueSpaceDate");

/**
 * A reserved space id that no Venue.spaces subdocument can ever have.
 * ObjectIds are timestamped from the Unix epoch onwards, so the all-zero id is
 * never generated for a real document.
 */
const WHOLE_VENUE_SPACE_ID = new mongoose.Types.ObjectId("000000000000000000000000");

const isWholeVenueSpace = (id) => String(id) === String(WHOLE_VENUE_SPACE_ID);

/** The spaces a whole-venue claim covers: every bookable one, plus the sentinel. */
function wholeVenueSpaceIds(venue) {
  const real = (venue.spaces || [])
    .filter((s) => s.isBookable !== false)
    .map((s) => s._id);
  return [...real, WHOLE_VENUE_SPACE_ID];
}

/**
 * A space was just added to a venue. If the whole property is already claimed
 * on future dates, that new space has no row on those dates and would
 * otherwise be bookable — "impossible unless someone edits their listing",
 * which is not impossible.
 *
 * ACROSS EVERY AFFECTED DATE, not just one: a venue can have the whole property
 * sold on many future dates and all of them need the new space.
 *
 * NEVER SILENTLY SUCCEEDS. Rows are inserted unordered so one collision does
 * not abandon the rest, and the result reports exactly what happened —
 * including any date left uncovered. A caller that ignores the report is the
 * only way this can go quiet, and the callers below do not.
 *
 * @returns {{ dates: number, inserted: number, alreadyPresent: number,
 *             failed: Array<{date: Date, reason: string}>, ok: boolean }}
 */
async function backfillNewSpaceIntoWholeVenueBlocks(venueId, newSpaceId, { session } = {}) {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  // Every future date on which the whole property is claimed. The sentinel is
  // what makes this a single indexed lookup rather than a scan.
  const anchors = await VenueSpaceDate.find({
    venue: venueId,
    space: WHOLE_VENUE_SPACE_ID,
    date: { $gte: startOfToday },
  })
    .select("date state holdRef bookingRef batchRef")
    .lean();

  if (!anchors.length) {
    return { dates: 0, inserted: 0, alreadyPresent: 0, failed: [], ok: true };
  }

  // UPSERT, not insert. Two reasons this is better than insertMany here:
  //   · it is IDEMPOTENT — running the backfill twice cannot fail or duplicate,
  //     which matters because a venue can be saved repeatedly;
  //   · it REPORTS PRECISELY without parsing driver error internals.
  //     upsertedCount is what we added, matchedCount is what was already
  //     covered, and writeErrors are genuine failures. Reading counts beats
  //     inferring them from an exception, which is how a partial backfill
  //     would otherwise pass as success.
  const ops = anchors.map((a) => ({
    updateOne: {
      filter: { venue: venueId, space: newSpaceId, date: a.date },
      update: {
        $setOnInsert: {
          venue: venueId,
          space: newSpaceId,
          date: a.date,
          state: a.state,
          ...(a.holdRef ? { holdRef: a.holdRef } : {}),
          ...(a.bookingRef ? { bookingRef: a.bookingRef } : {}),
          // Same batch as the claim it belongs to, so releasing that claim
          // releases this row with it rather than orphaning a block nobody
          // can find.
          ...(a.batchRef ? { batchRef: a.batchRef } : {}),
          notes: "Added to an existing entire-property block when this space was created.",
        },
      },
      upsert: true,
    },
  }));

  let inserted = 0;
  let alreadyPresent = 0;
  const failed = [];
  try {
    const res = await VenueSpaceDate.bulkWrite(ops, { ordered: false, session });
    inserted = res.upsertedCount || 0;
    alreadyPresent = res.matchedCount || 0;
  } catch (e) {
    const r = e.result || {};
    inserted = r.upsertedCount ?? r.nUpserted ?? 0;
    alreadyPresent = r.matchedCount ?? r.nMatched ?? 0;
    for (const we of e.writeErrors || []) {
      const i = typeof we.index === "number" ? we.index : (we.err && we.err.index);
      const d = i != null && anchors[i] ? anchors[i].date : null;
      failed.push({ date: d, reason: (we.errmsg || (we.err && we.err.errmsg)) || String(we.code || we) });
    }
    if (!(e.writeErrors || []).length) failed.push({ date: null, reason: e.message });
  }

  return {
    dates: anchors.length,
    inserted,
    alreadyPresent,
    failed,
    // Covered means every affected date now has a row for this space, whether
    // this call inserted it or found it already there.
    ok: failed.length === 0 && inserted + alreadyPresent === anchors.length,
  };
}

module.exports = {
  WHOLE_VENUE_SPACE_ID,
  isWholeVenueSpace,
  wholeVenueSpaceIds,
  backfillNewSpaceIntoWholeVenueBlocks,
};

/**
 * utils/venueRoomLayout.js — the property's shape, resolved once.
 *
 * ── THE PROBLEM THIS EXISTS TO REMOVE ───────────────────────────────────────
 * Blocks and floors are both optional. A resort of cottages has neither; a
 * single building may have blocks and no floors; a venue that has never
 * organised its rooms has 21 rooms and no structure at all.
 *
 * Represented naively — "does this venue have blocks?" — every consumer gets a
 * branch, and the branch somebody forgets is the bug. So this returns the SAME
 * SHAPE EVERY TIME:
 *
 *     blocks[] → floors[] → rooms[]
 *
 * always three levels, always arrays. A venue with no blocks resolves to one
 * IMPLICIT block containing one IMPLICIT floor containing every room. A block
 * with no floors gets one implicit floor. Callers loop; they never ask.
 *
 * `isImplicit` exists so a SCREEN can decide not to draw a header for a level
 * the owner never created — that is a rendering decision, not a structural one,
 * and it is the only thing the flag is for.
 *
 * ── UNPLACED IS NOT THE SAME AS UNSTRUCTURED ────────────────────────────────
 * A room with no blockRef means two different things:
 *
 *   the venue has NO blocks   → nothing is misplaced; this is simply the whole
 *                               property, and the implicit block is unlabelled
 *   the venue HAS blocks      → this room has not been placed yet, and it goes
 *                               into a trailing bucket the screen can name
 *
 * Telling those apart HERE is the point: 21 rooms at a venue that has never
 * used blocks are a normal layout, not 21 problems. That is also exactly what
 * every existing venue looks like the day this ships.
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 * Blocks and floors come back in ARRAY ORDER, which is the owner's order.
 * Nothing here sorts them: "Ground" sorts after "First" alphabetically and
 * after "1" numerically, and "G / M / 1 / 2" defeats every rule anyone has
 * tried. Rooms within a floor keep their insertion order for the same reason —
 * bulk creation inserts 101…110 in order, and that is already what the owner
 * meant.
 */

const idOf = (v) => (v === null || v === undefined ? "" : String(v._id || v));

/** The bucket for rooms that have not been placed, when there IS a structure. */
const UNPLACED_BLOCK_ID = "__unplaced__";

/**
 * ── HOW MANY STOREYS DOES THIS PROPERTY HAVE ────────────────────────────────
 * DISTINCT FLOOR NAMES, not block-floor pairs.
 *
 * A floor BELONGS TO A BLOCK — that is the storage, and it is right: two blocks
 * genuinely have their own Ground, and renaming one must not rename the other.
 * But this header is not counting objects, it is answering an owner's question,
 * and an owner whose Garden Block and Lake Wing both run Ground and First says
 * their property has two storeys. It reported four.
 *
 *   Garden{Ground,First} + Lake{Ground,First,Second}
 *     block-floor pairs → 5      what it used to say
 *     distinct names    → 3      what an owner would say
 *
 * ── THIS COUNT IS ONLY HONEST BECAUSE THE FLOOR PICKER EXISTS ───────────────
 * Distinct-name counting assumes floor names are a CONTROLLED VOCABULARY. If
 * one block says "1st" and another says "First", a three-storey property
 * reports four storeys and this function is quietly wrong in the direction it
 * was written to fix.
 *
 * The floor suggestion picker is therefore NOT COSMETIC. It is what keeps two
 * blocks agreeing on what a storey is called, and this arithmetic is
 * load-bearing on it. Removing it, or adding a path that writes floor names
 * without it, silently degrades this number. They are one feature in two
 * halves; do not treat them as independent.
 *
 * ── WHAT IT ACTUALLY OFFERS, KEPT CURRENT ──────────────────────────────────
 * This line said "Ground / Lobby / Mezzanine / 1–10 / Terrace" and had been
 * wrong since ROOMS 9 replaced the digits with ordinals. A stale description of
 * the half this arithmetic depends on, sitting directly above the paragraph
 * explaining that dependency, is the comment a future reader would trust most.
 *
 *   always shown   Ground, Lobby, Mezzanine, First … Tenth, and Terrace
 *   behind a tap   Eleventh … Twentieth
 *   pinned last    Terrace, in both states — it is a top-of-building answer,
 *                  not a numbered storey, so it must not scroll out with the
 *                  ordinals
 *
 * Above the twentieth the box takes free text, which is the point at which
 * uniformity stops being guaranteed and this count starts depending on the
 * owner. See wedsy-venue app/(portal)/dashboard/_components/suggest-field.tsx
 * and its rule in suggest-visible.ts.
 *
 * Matched case-insensitively and trimmed, because "Ground" and "ground " are
 * one storey by any reading. NOTHING IS WRITTEN — the stored name stays exactly
 * as the owner typed it, as everywhere else in this file.
 *
 * @param {object} venue a Venue doc or lean object
 * @returns {number} distinct storeys across the whole property
 */
function distinctFloorCount(venue) {
  const seen = new Set();
  for (const b of (venue && venue.blocks) || []) {
    for (const f of b.floors || []) {
      const key = String(f.name || "").trim().toLowerCase();
      // `name` is required in the schema, so an empty one cannot be created.
      // Skipped rather than counted as a storey called "" if older data has one.
      if (key) seen.add(key);
    }
  }
  return seen.size;
}

/**
 * @param {object} venue                a Venue doc or lean object
 * @param {object} [opts]
 * @param {(room:object)=>object} [opts.presentRoom] map each room on the way out
 * @returns {{blocks: object[], counts: object}}
 */
function resolveLayout(venue, { presentRoom } = {}) {
  const v = venue || {};
  const blocks = Array.from(v.blocks || []);
  const rooms = Array.from(v.rooms || []);
  const present = typeof presentRoom === "function" ? presentRoom : (r) => r;

  // Rooms indexed by where they claim to be, so placement is one pass rather
  // than a filter per floor (a 200-room venue with 20 floors is 4000 scans).
  const byFloor = new Map();
  const byBlockNoFloor = new Map();
  const loose = [];
  const knownBlocks = new Set(blocks.map((b) => idOf(b._id)));
  const knownFloors = new Set(
    blocks.flatMap((b) => (b.floors || []).map((f) => `${idOf(b._id)}:${idOf(f._id)}`))
  );

  for (const room of rooms) {
    const bId = idOf(room.blockRef);
    const fId = idOf(room.floorRef);
    // A ref pointing at a block or floor that no longer exists is treated as
    // unplaced rather than dropped. Losing a room off the layout because its
    // block was deleted is how a room stops being cleaned.
    if (!bId || !knownBlocks.has(bId)) { loose.push(room); continue; }
    if (fId && knownFloors.has(`${bId}:${fId}`)) {
      const key = `${bId}:${fId}`;
      if (!byFloor.has(key)) byFloor.set(key, []);
      byFloor.get(key).push(room);
    } else {
      if (!byBlockNoFloor.has(bId)) byBlockNoFloor.set(bId, []);
      byBlockNoFloor.get(bId).push(room);
    }
  }

  const out = [];

  if (blocks.length === 0) {
    // ── NO STRUCTURE AT ALL ────────────────────────────────────────────────
    // One implicit block, one implicit floor, every room. Not "unplaced" —
    // there is nowhere to place anything, so nothing is missing.
    out.push({
      _id: null,
      name: "",
      isImplicit: true,
      isUnplaced: false,
      // Implicit levels have no stored row to retire, so they are always in
      // use. Stated rather than omitted, because the whole point of this shape
      // is that a consumer loops and never asks which kind of level it has.
      isActive: true,
      floors: [{
        _id: null,
        name: "",
        isImplicit: true,
        isActive: true,
        rooms: rooms.map(present),
      }],
    });
  } else {
    for (const b of blocks) {
      const bId = idOf(b._id);
      const floors = Array.from(b.floors || []);
      const resolvedFloors = floors.map((f) => ({
        _id: f._id,
        name: f.name,
        isImplicit: false,
        // ── CARRIED, NEVER FILTERED ON ──────────────────────────────────────
        // A block or floor taken out of use is the step before deleting it, and
        // it says nothing about whether the rooms inside can be sold. Filtering
        // here would take a property's inventory off the screen because
        // somebody started tidying the layout. Rooms keep their own isActive,
        // and that is the only one availability reads.
        isActive: f.isActive !== false,
        rooms: (byFloor.get(`${bId}:${idOf(f._id)}`) || []).map(present),
      }));

      // Rooms sitting in the block itself. When the block has no floors at all
      // this is the whole block and the floor is unnamed; when it DOES have
      // floors, these are rooms in the block but not on a floor, and they still
      // need somewhere to render.
      const direct = byBlockNoFloor.get(bId) || [];
      if (floors.length === 0 || direct.length > 0) {
        resolvedFloors.push({
          _id: null,
          name: "",
          isImplicit: true,
          // An implicit floor has no row to retire, so it is always in use.
          isActive: true,
          rooms: direct.map(present),
        });
      }

      out.push({
        _id: b._id,
        name: b.name,
        isImplicit: false,
        isUnplaced: false,
        isActive: b.isActive !== false,
        floors: resolvedFloors,
      });
    }

    // ── PLACED NOWHERE, WHILE A STRUCTURE EXISTS ───────────────────────────
    // A real bucket with a real id, so the screen can name it and offer to move
    // them. Only appears when it has something in it.
    if (loose.length) {
      out.push({
        _id: UNPLACED_BLOCK_ID,
        name: "",
        isImplicit: true,
        isUnplaced: true,
        isActive: true,
        floors: [{ _id: null, name: "", isImplicit: true, isActive: true, rooms: loose.map(present) }],
      });
    }
  }

  const activeRooms = rooms.filter((r) => r.isActive !== false);
  return {
    blocks: out,
    counts: {
      /** Every room on the venue, active or not. */
      rooms: rooms.length,
      active: activeRooms.length,
      inactive: rooms.length - activeRooms.length,
      blocks: blocks.length,
      /** Storeys, not block-floor pairs — see distinctFloorCount. */
      floors: distinctFloorCount(venue),
      /** Rooms with no place, when there is a structure to have a place in. */
      unplaced: blocks.length ? loose.length : 0,
    },
  };
}

/**
 * Where one room is, in words the owner typed.
 * "Garden Block · Ground" / "Garden Block" / "" — never invented.
 */
function locationLabel(venue, room) {
  const v = venue || {};
  const b = (v.blocks || []).find((x) => idOf(x._id) === idOf(room && room.blockRef));
  if (!b) return "";
  const f = (b.floors || []).find((x) => idOf(x._id) === idOf(room && room.floorRef));
  return f ? `${b.name} · ${f.name}` : b.name;
}

/** Does this {blockRef, floorRef} pair actually exist on this venue? */
function validatePlacement(venue, blockRef, floorRef) {
  const v = venue || {};
  if (!blockRef) {
    // floorRef alone is meaningless — a floor only exists inside a block.
    if (floorRef) return { ok: false, message: "A floor has to belong to a block." };
    return { ok: true, value: { blockRef: null, floorRef: null } };
  }
  const b = (v.blocks || []).find((x) => idOf(x._id) === idOf(blockRef));
  if (!b) return { ok: false, message: "That block does not exist at this venue." };
  if (!floorRef) return { ok: true, value: { blockRef: b._id, floorRef: null } };
  const f = (b.floors || []).find((x) => idOf(x._id) === idOf(floorRef));
  if (!f) return { ok: false, message: `That floor does not exist in ${b.name}.` };
  return { ok: true, value: { blockRef: b._id, floorRef: f._id } };
}

module.exports = {
  resolveLayout,
  locationLabel,
  validatePlacement,
  // Exported so venueRoomSetup counts storeys the same way this file does.
  // It had its OWN copy of the pair-summing arithmetic, which is how the two
  // came to disagree with what an owner sees — one fact, one implementation.
  distinctFloorCount,
  UNPLACED_BLOCK_ID,
};

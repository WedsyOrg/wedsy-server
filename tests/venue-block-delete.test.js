// ROOMS 7 slice 2 — blocks and floors: out of use first, then delete.
//
// ── THE TWO THINGS THIS HAS TO GET RIGHT AT ONCE ────────────────────────────
// 1. Deleting is a second act. A block in use is refused, and the refusal
//    leaves the block exactly where it was.
// 2. Taking a block out of use MUST NOT take its rooms out of service.
//
// The second is the one that would be a disaster and would still look like a
// success. A block is where a room IS, not whether it can be sold; a guard that
// removed a property's inventory because somebody started tidying the layout
// would be a much worse bug than the accidental deletion the two-step prevents.
// So every deactivation case here asserts the rooms are STILL SELLABLE
// afterwards — read off the stored document, and through the same
// bookableRooms() that availability itself calls, not off a flag.
//
// Run: node tests/venue-block-delete.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const blocks = require("../controllers/venueRoomBlocks");
const { bookableRooms, nightKeys } = require("../utils/venueRoomNights");
const { resolveLayout } = require("../utils/venueRoomLayout");

const TAG = `bd-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const req = (venue, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { venueId: String(venue._id) },
});

let seq = 0;
const made = [];

/** A venue with one block, one floor, and three rooms placed on it. */
async function fixture({ place = 2 } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    rooms: Array.from({ length: 3 }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
  });
  made.push(venue);
  const b = await call(blocks.addBlock, req(venue, { body: { name: "Garden Block", floors: ["Ground"] } }));
  if (b.code !== 201) throw new Error(`fixture block failed: ${JSON.stringify(b.body)}`);
  const blockId = String(b.body.blocks[0]._id);
  const floorId = String(b.body.blocks[0].floors[0]._id);

  const fresh = await Venue.findById(venue._id);
  for (let i = 0; i < place; i++) {
    const p = await call(blocks.placeRoom, req(fresh, {
      params: { roomId: String(fresh.rooms[i]._id) }, body: { blockRef: blockId, floorRef: floorId },
    }));
    if (p.code !== 200) throw new Error(`fixture placement failed: ${JSON.stringify(p.body)}`);
  }
  return { venue, blockId, floorId };
}

const storedBlocks = async (venueId) =>
  (await Venue.findById(venueId).select("blocks").lean()).blocks || [];
const storedBlock = async (venueId, blockId) =>
  (await storedBlocks(venueId)).find((b) => String(b._id) === String(blockId)) || null;

/** What availability itself would sell tonight — not a flag, the real filter. */
async function sellableRoomNames(venueId) {
  const v = await Venue.findById(venueId).lean();
  const nights = nightKeys(new Date("2036-05-10T10:00:00Z"), new Date("2036-05-11T10:00:00Z"));
  return bookableRooms(v, nights).map((r) => r.name).sort();
}

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  console.log(`DB: ${mongoose.connection.name}`);

  try {
    console.log("\n[1. a block in use cannot be deleted in one click]");
    {
      const f = await fixture();
      eq((await storedBlocks(f.venue._id)).length, 1, "the fixture block really exists");

      const r = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(r.code, 409, "🔴 refused");
      eq(r.body.code, "block_active", "…as the two-step refusal, not the rooms-inside one");
      ok(/take it out of use first/i.test(r.body.message), `…in words: ${JSON.stringify(r.body.message)}`);
      ok(r.body.message.includes('"Garden Block"'), "…naming the block");
      ok(/cannot be undone/i.test(r.body.message), "…and saying deletion is permanent");
      eq(r.body.canDeactivate, true, "…and pointing at the step that IS available");

      eq((await storedBlocks(f.venue._id)).length, 1, "🔴 THE STORED BLOCK IS STILL THERE");
    }

    console.log("\n[2. 🔴 taking a block out of use does NOT take its rooms out of service]");
    {
      const f = await fixture({ place: 2 });
      const before = await sellableRoomNames(f.venue._id);
      eq(before.join(","), "R1,R2,R3", "all three rooms are sellable to begin with");

      const p = await call(blocks.updateBlock, req(f.venue, {
        params: { blockId: f.blockId }, body: { isActive: false },
      }));
      eq(p.code, 200, "the block is taken out of use");
      eq((await storedBlock(f.venue._id, f.blockId)).isActive, false, "…and stored as such");

      const after = await sellableRoomNames(f.venue._id);
      eq(after.join(","), "R1,R2,R3",
        "🔴 ALL THREE ROOMS ARE STILL SELLABLE — a block is where a room is, not whether it can be sold");

      const stored = await Venue.findById(f.venue._id).lean();
      eq(stored.rooms.filter((r) => r.isActive !== false).length, 3, "🔴 …and none of them was deactivated");
      eq(stored.rooms.filter((r) => String(r.blockRef) === f.blockId).length, 2,
        "🔴 …and they are still IN the block, not pre-emptively unplaced");

      // And the layout still renders them, or they would vanish off the screen.
      const layout = resolveLayout(stored);
      const block = layout.blocks.find((b) => String(b._id) === f.blockId);
      ok(!!block, "🔴 the deactivated block is still IN the layout, not filtered out");
      eq(block.isActive, false, "…flagged, so the screen can group it");
      eq(block.floors.reduce((n, fl) => n + fl.rooms.length, 0), 2,
        "🔴 …still carrying its 2 rooms, so nothing falls off the property view");
    }

    console.log("\n[3. out of use, then delete — naming what happens to the rooms first]");
    {
      const f = await fixture({ place: 2 });
      await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: { isActive: false } }));

      const warn = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(warn.code, 409, "🔴 still refused — now about the rooms inside");
      eq(warn.body.code, "block_in_use", "…with the rooms-inside code");
      eq(warn.body.roomCount, 2, "🔴 …NAMING THE COUNT on its own field");
      ok(/2 rooms are in Garden Block/i.test(warn.body.message), `…and in the sentence: ${JSON.stringify(warn.body.message)}`);
      ok(/unplaced/i.test(warn.body.message), "🔴 …saying what becomes of them, before it happens");
      ok(warn.body.rooms.includes("R1") && warn.body.rooms.includes("R2"), `…and naming them: ${JSON.stringify(warn.body.rooms)}`);
      ok(!warn.body.rooms.includes("R3"), "…but not the room that was never in it");
      eq((await storedBlocks(f.venue._id)).length, 1, "…and the block survived the warning");

      const done = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId }, query: { force: "1" } }));
      eq(done.code, 200, "acknowledged, it goes");
      eq(done.body.deletedName, "Garden Block", "…naming what went");
      eq(done.body.unplaced, 2, "…and reporting what it did to the rooms");
      eq((await storedBlocks(f.venue._id)).length, 0, "🔴 THE STORED BLOCK IS GONE");

      const stored = await Venue.findById(f.venue._id).lean();
      eq(stored.rooms.length, 3, "🔴 …and NO ROOM WAS CASCADED — all three survive");
      eq(stored.rooms.filter((r) => r.blockRef == null).length, 3, "…all unplaced, exactly as warned");
      eq((await sellableRoomNames(f.venue._id)).join(","), "R1,R2,R3", "🔴 …and every one still sellable");
    }

    console.log("\n[4. an EMPTY block out of use deletes with no second warning]");
    {
      const f = await fixture({ place: 0 });
      const early = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(early.code, 409, "even empty, it is still a two-step");
      eq(early.body.code, "block_active", "…for the two-step reason only");

      await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: { isActive: false } }));
      const r = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(r.code, 200, "🔴 no rooms inside, so no force needed");
      eq(r.body.unplaced, 0, "…and nothing was unplaced");
      eq((await storedBlocks(f.venue._id)).length, 0, "🔴 …and it is really gone");
    }

    console.log("\n[5. put back — the two-step is reversible right up to the delete]");
    {
      const f = await fixture();
      await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: { isActive: false } }));
      eq((await storedBlock(f.venue._id, f.blockId)).isActive, false, "out of use");

      const back = await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: { isActive: true } }));
      eq(back.code, 200, "put back");
      eq((await storedBlock(f.venue._id, f.blockId)).isActive, true, "🔴 …and stored as in use again");

      const r = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(r.code, 409, "🔴 …so delete is refused again — the step really was undone");
      eq(r.body.code, "block_active", "…for the two-step reason");
    }

    console.log("\n[6. renaming still works, and does not disturb the two-step]");
    {
      const f = await fixture();
      const rn = await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: { name: "West Wing" } }));
      eq(rn.code, 200, "renamed");
      const b = await storedBlock(f.venue._id, f.blockId);
      eq(b.name, "West Wing", "…in the stored document");
      eq(b.isActive, true, "🔴 …and a rename did NOT quietly retire it");

      const empty = await call(blocks.updateBlock, req(f.venue, { params: { blockId: f.blockId }, body: {} }));
      eq(empty.code, 400, "🔴 a patch naming neither field is still refused, not silently accepted");
    }

    console.log("\n[7. floors take the same two steps, and keep their rooms in the block]");
    {
      const f = await fixture({ place: 2 });

      const early = await call(blocks.deleteFloor, req(f.venue, {
        params: { blockId: f.blockId, floorId: f.floorId },
      }));
      eq(early.code, 409, "🔴 a floor in use is not deletable either");
      eq(early.body.code, "floor_active", "…with its own code");
      ok(/take it out of use first/i.test(early.body.message), "…and the same instruction");
      ok(early.body.message.includes('"Ground"'), "…naming the floor");

      const off = await call(blocks.updateFloor, req(f.venue, {
        params: { blockId: f.blockId, floorId: f.floorId }, body: { isActive: false },
      }));
      eq(off.code, 200, "taken out of use");
      eq((await sellableRoomNames(f.venue._id)).join(","), "R1,R2,R3",
        "🔴 …and its rooms are STILL SELLABLE");

      const warn = await call(blocks.deleteFloor, req(f.venue, {
        params: { blockId: f.blockId, floorId: f.floorId },
      }));
      eq(warn.code, 409, "refused again, now about the rooms on it");
      eq(warn.body.code, "floor_in_use", "…with the rooms-on-it code");
      eq(warn.body.roomCount, 2, "🔴 …naming the count");
      ok(/in Garden Block with no floor/i.test(warn.body.message),
        `🔴 …and saying they stay in the BLOCK, not that they are unplaced: ${JSON.stringify(warn.body.message)}`);

      const done = await call(blocks.deleteFloor, req(f.venue, {
        params: { blockId: f.blockId, floorId: f.floorId }, query: { force: "1" },
      }));
      eq(done.code, 200, "acknowledged, it goes");
      eq(done.body.keptInBlock, 2, "…reporting what it did");

      const stored = await Venue.findById(f.venue._id).lean();
      eq(stored.blocks[0].floors.length, 0, "🔴 the floor is gone from the stored document");
      eq(stored.rooms.filter((r) => String(r.blockRef) === f.blockId).length, 2,
        "🔴 …and both rooms are STILL IN THE BLOCK, exactly as promised");
      eq(stored.rooms.filter((r) => r.floorRef == null).length, 3, "…with only their floor cleared");
      eq((await sellableRoomNames(f.venue._id)).join(","), "R1,R2,R3", "🔴 …and still sellable");
    }

    console.log("\n[8. every block that already exists reads as in use — no backfill]");
    {
      const f = await fixture({ place: 0 });
      // A block written before isActive existed: the field is simply absent.
      await Venue.updateOne({ _id: f.venue._id }, { $unset: { "blocks.0.isActive": "" } });
      const raw = await storedBlock(f.venue._id, f.blockId);
      eq(raw.isActive, undefined, "the stored field really is absent");

      const r = await call(blocks.deleteBlock, req(f.venue, { params: { blockId: f.blockId } }));
      eq(r.code, 409, "🔴 absent reads as IN USE — an old block is not accidentally deletable");
      eq(r.body.code, "block_active", "…via the two-step refusal");

      const layout = resolveLayout(await Venue.findById(f.venue._id).lean());
      eq(layout.blocks[0].isActive, true, "🔴 …and the layout reports it as in use");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      for (const v of made) await Venue.deleteMany({ _id: v._id });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();

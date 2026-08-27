// ROOMS 3 / slice 1 — where a room IS.
//
// Blocks and floors are both optional, and the whole design rests on one claim:
// that OPTIONAL does not mean SPECIAL-CASED. resolveLayout returns the same
// three-level shape whatever the venue holds, so no consumer ever asks "does
// this venue have blocks".
//
// This suite tries to break that claim from every direction — no blocks, blocks
// with no floors, blocks with floors, a mixture, rooms placed nowhere, and refs
// pointing at things that have been deleted — and asserts the shape is uniform
// every time.
//
// It also pins the two rules that are easy to "improve" into bugs:
//   · names are stored EXACTLY as typed, never normalised
//   · order is the ARRAY, never a sort — "Ground" must not follow "First"
//
// Every write goes through the CONTROLLER with a real request shape.
//
// Run: node tests/venue-room-layout.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const blocks = require("../controllers/venueRoomBlocks");
const rooms = require("../controllers/venueRooms");
const rt = require("../controllers/venueRoomTypes");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");
const { resolveLayout, locationLabel, validatePlacement } = require("../utils/venueRoomLayout");

const TAG = `layout-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = [];
const madeAllotments = [];
const madeNights = [];
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

let venue;
const asOwner = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
});

/** Every level of every block, flattened — the shape callers actually loop. */
const shapeOf = (layout) =>
  layout.map((b) => ({ name: b.name, implicit: b.isImplicit, floors: b.floors.map((f) => ({ name: f.name, n: f.rooms.length })) }));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ 1. THE SHAPE IS UNIFORM ═════════════════════════════════════════════
    console.log("\n[a venue with NO structure — which is every venue today]");
    const bare = { rooms: [{ _id: "a", name: "101", isActive: true }, { _id: "b", name: "102", isActive: true }] };
    const flat = resolveLayout(bare);
    ok(flat.blocks.length === 1, "resolves to exactly one block");
    ok(flat.blocks[0].isImplicit === true, "…flagged implicit, so a screen knows not to draw a header");
    ok(flat.blocks[0].isUnplaced === false,
      "…and NOT flagged unplaced — nothing is misplaced when there is nowhere to place it");
    ok(flat.blocks[0].floors.length === 1 && flat.blocks[0].floors[0].isImplicit === true, "…holding one implicit floor");
    ok(flat.blocks[0].floors[0].rooms.length === 2, "…holding every room");
    ok(flat.counts.unplaced === 0, "counts.unplaced is 0 — 21 rooms with no blocks are a layout, not 21 problems");

    console.log("\n[an EMPTY venue still resolves to the same shape]");
    const empty = resolveLayout({});
    ok(empty.blocks.length === 1 && empty.blocks[0].floors.length === 1, "one block, one floor…");
    ok(empty.blocks[0].floors[0].rooms.length === 0, "…and no rooms — an empty loop, not a null");
    ok(resolveLayout(null).blocks.length === 1, "resolveLayout(null) does not throw");

    // ══ 2. THROUGH THE REAL WRITE PATH ══════════════════════════════════════
    console.log("\n[the founder's property: two blocks, ground + first each]");
    venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.push(venue._id);

    const b1 = await call(blocks.addBlock, asOwner({ body: { name: "Garden Block", floors: ["Ground", "First"] } }));
    ok(b1.code === 201, `POST a block with two floors → 201 (got ${b1.code})`);
    const garden = b1.body.block;
    const b2 = await call(blocks.addBlock, asOwner({ body: { name: "Main Block", floors: ["Ground", "First"] } }));
    ok(b2.code === 201, "…and a second block");
    const main = b2.body.block;

    console.log("\n[names are stored EXACTLY as typed]");
    const odd = await call(blocks.addBlock, asOwner({ body: { name: "  cottages  ", floors: ["G", "0", "M"] } }));
    ok(odd.code === 201, "a block called 'cottages' with floors G / 0 / M");
    const cottages = odd.body.block;
    ok(cottages.name === "cottages", `name kept lower-case as typed (got "${cottages.name}") — trimmed, not title-cased`);
    ok(cottages.floors.map((f) => f.name).join(",") === "G,0,M",
      `floor names kept verbatim: ${cottages.floors.map((f) => f.name).join(", ")}`);

    console.log("\n[order is the ARRAY — 'Ground' must not sort after 'First']");
    const fresh = await Venue.findById(venue._id);
    const gardenFloors = fresh.blocks.id(garden._id).floors.map((f) => f.name);
    ok(gardenFloors.join(",") === "Ground,First", `stored in the order given: ${gardenFloors.join(" → ")}`);
    ok(gardenFloors[0] === "Ground", "…Ground FIRST, which no alphabetical or numeric sort would produce");
    const layoutNames = (await call(blocks.getLayout, asOwner())).body.layout.map((b) => b.name);
    ok(layoutNames.join(",") === "Garden Block,Main Block,cottages", `blocks come back in creation order: ${layoutNames.join(" → ")}`);

    console.log("\n[reordering rewrites the array, and must name every id]");
    const short = await call(blocks.reorder, asOwner({ body: { blocks: [String(main._id)] } }));
    ok(short.code === 400 && short.body.code === "reorder_mismatch", `a partial list → 400 (got ${short.code})`);
    ok(/in full — got 1 of 3/.test(short.body.message), `…saying what is missing: "${short.body.message}"`);
    const dup = await call(blocks.reorder, asOwner({ body: { blocks: [String(main._id), String(main._id), String(garden._id)] } }));
    ok(dup.code === 400 && /repeats/.test(dup.body.message), "a repeated id → 400");
    const good = await call(blocks.reorder, asOwner({
      body: { blocks: [String(cottages._id), String(main._id), String(garden._id)] },
    }));
    ok(good.code === 200, `a full list → 200 (got ${good.code})`);
    ok(good.body.layout.map((b) => b.name).join(",") === "cottages,Main Block,Garden Block", "…and the order is exactly as sent");
    const floorOrder = await call(blocks.reorder, asOwner({
      body: { blockId: String(garden._id), floors: (await Venue.findById(venue._id)).blocks.id(garden._id).floors.map((f) => String(f._id)).reverse() },
    }));
    ok(floorOrder.code === 200, "floors reorder inside one block");
    ok(
      (await Venue.findById(venue._id)).blocks.id(garden._id).floors.map((f) => f.name).join(",") === "First,Ground",
      "…and the floors really moved",
    );

    // ══ 3. PLACING ROOMS ════════════════════════════════════════════════════
    console.log("\n[rooms go somewhere, and a bad pair is refused]");
    await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
    const deluxe = (await call(rt.addRoomType, asOwner({ body: { name: "Deluxe", sleeps: 2, defaultRate: 4500 } }))).body.roomType;
    const mk = async (name) => (await call(rooms.addRoom, asOwner({ body: { name, typeRef: String(deluxe._id) } }))).body.room;
    const r101 = await mk("101"), r102 = await mk("102"), r201 = await mk("201");

    const v2 = await Venue.findById(venue._id);
    const gGround = v2.blocks.id(garden._id).floors.find((f) => f.name === "Ground");
    const mGround = v2.blocks.id(main._id).floors.find((f) => f.name === "Ground");

    const wrongPair = await call(blocks.placeRoom, asOwner({
      params: { roomId: String(r101._id) },
      body: { blockRef: String(main._id), floorRef: String(gGround._id) },
    }));
    ok(wrongPair.code === 400, `a floor from ANOTHER block → 400 (got ${wrongPair.code})`);
    ok(/does not exist in Main Block/.test(wrongPair.body.message), `…naming the block: "${wrongPair.body.message}"`);

    const floorOnly = await call(blocks.placeRoom, asOwner({
      params: { roomId: String(r101._id) }, body: { floorRef: String(gGround._id) },
    }));
    ok(floorOnly.code === 400 && /belong to a block/.test(floorOnly.body.message), "a floor with no block → 400");

    ok((await call(blocks.placeRoom, asOwner({ params: { roomId: String(r101._id) }, body: { blockRef: String(garden._id), floorRef: String(gGround._id) } }))).code === 200, "101 → Garden Block · Ground");
    ok((await call(blocks.placeRoom, asOwner({ params: { roomId: String(r102._id) }, body: { blockRef: String(garden._id) } }))).code === 200, "102 → Garden Block, no floor");
    ok((await call(blocks.placeRoom, asOwner({ params: { roomId: String(r201._id) }, body: { blockRef: String(main._id), floorRef: String(mGround._id) } }))).code === 200, "201 → Main Block · Ground");

    console.log("\n[a block with floors AND rooms sitting directly in it]");
    const withMix = await call(blocks.getLayout, asOwner());
    const gardenOut = withMix.body.layout.find((b) => b.name === "Garden Block");
    const gardenShape = gardenOut.floors.map((f) => `${f.name || "(none)"}:${f.rooms.length}`);
    ok(gardenShape.includes("Ground:1"), `Ground holds 101 (${gardenShape.join(", ")})`);
    ok(gardenOut.floors.some((f) => f.isImplicit && f.rooms.length === 1),
      "…and the block-level room gets an implicit unnamed floor rather than vanishing");

    console.log("\n[a block with NO floors is not a special case either]");
    const noFloors = await call(blocks.addBlock, asOwner({ body: { name: "Poolside" } }));
    ok(noFloors.code === 201 && (noFloors.body.block.floors || []).length === 0, "a block created with no floors at all");
    const rp = await mk("Poolside Cottage");
    await call(blocks.placeRoom, asOwner({ params: { roomId: String(rp._id) }, body: { blockRef: String(noFloors.body.block._id) } }));
    const pool = (await call(blocks.getLayout, asOwner())).body.layout.find((b) => b.name === "Poolside");
    ok(pool.floors.length === 1 && pool.floors[0].isImplicit === true, "…resolves to ONE implicit floor");
    ok(pool.floors[0].rooms.length === 1, "…holding its room, same shape as every other floor");

    console.log("\n[unplaced, once a structure exists, is its own bucket]");
    const stray = await mk("Store Room");
    const withStray = await call(blocks.getLayout, asOwner());
    const bucket = withStray.body.layout.find((b) => b.isUnplaced);
    ok(Boolean(bucket), "an unplaced bucket appears");
    ok(bucket.floors[0].rooms.length === 1 && bucket.floors[0].rooms[0].name === "Store Room", "…holding the unplaced room");
    ok(withStray.body.counts.unplaced === 1, `counts.unplaced is ${withStray.body.counts.unplaced}`);
    ok(withStray.body.layout.filter((b) => b.isUnplaced).length === 1, "…exactly one bucket, and it is last");
    ok(withStray.body.layout[withStray.body.layout.length - 1].isUnplaced === true, "…at the end, after the real blocks");

    console.log("\n[a room pointing at a deleted block is unplaced, never dropped]");
    const ghost = resolveLayout({
      blocks: [{ _id: new mongoose.Types.ObjectId(), name: "B", floors: [] }],
      rooms: [{ _id: "z", name: "Orphan", isActive: true, blockRef: new mongoose.Types.ObjectId() }],
    });
    const total = ghost.blocks.reduce((n, b) => n + b.floors.reduce((m, f) => m + f.rooms.length, 0), 0);
    ok(total === 1, "the room still appears somewhere — losing it off the layout is how a room stops being cleaned");
    ok(ghost.blocks.some((b) => b.isUnplaced), "…in the unplaced bucket");

    // ══ 4. DELETING STRUCTURE ═══════════════════════════════════════════════
    // ROOMS 7: structure is taken out of use before it can be deleted, so the
    // rooms-inside warning is now the SECOND refusal. Both are asserted, in
    // order — the first one is what stops a one-click delete.
    console.log("\n[a block holding rooms is not removed silently]");
    const twoStep = await call(blocks.deleteBlock, asOwner({ params: { blockId: String(garden._id) } }));
    ok(twoStep.code === 409 && twoStep.body.code === "block_active", `→ 409 in use (got ${twoStep.code}/${twoStep.body.code})`);
    await call(blocks.updateBlock, asOwner({ params: { blockId: String(garden._id) }, body: { isActive: false } }));
    const refuse = await call(blocks.deleteBlock, asOwner({ params: { blockId: String(garden._id) } }));
    ok(refuse.code === 409 && refuse.body.code === "block_in_use", `→ 409 (got ${refuse.code})`);
    ok(/2 rooms are in Garden Block/.test(refuse.body.message), `…naming the count: "${refuse.body.message}"`);
    ok((refuse.body.rooms || []).length === 2, "…and which rooms");

    console.log("\n[removing a FLOOR keeps its rooms in the block]");
    const v3 = await Venue.findById(venue._id);
    const mg = v3.blocks.id(main._id).floors.find((f) => f.name === "Ground");
    const floorTwoStep = await call(blocks.deleteFloor, asOwner({ params: { blockId: String(main._id), floorId: String(mg._id) } }));
    ok(floorTwoStep.code === 409 && floorTwoStep.body.code === "floor_active", `→ 409 in use (got ${floorTwoStep.code}/${floorTwoStep.body.code})`);
    await call(blocks.updateFloor, asOwner({ params: { blockId: String(main._id), floorId: String(mg._id) }, body: { isActive: false } }));
    const floorRefuse = await call(blocks.deleteFloor, asOwner({ params: { blockId: String(main._id), floorId: String(mg._id) } }));
    ok(floorRefuse.code === 409 && /with no floor/.test(floorRefuse.body.message), `→ 409 naming the consequence: "${floorRefuse.body.message}"`);
    const forced = await call(blocks.deleteFloor, asOwner({ params: { blockId: String(main._id), floorId: String(mg._id) }, query: { force: "1" } }));
    ok(forced.code === 200 && forced.body.keptInBlock === 1, "forced: the room stays in the block, not dropped to unplaced");
    const after = await Venue.findById(venue._id);
    const moved = after.rooms.id(r201._id);
    ok(String(moved.blockRef) === String(main._id) && !moved.floorRef, "…blockRef kept, floorRef cleared");

    console.log("\n[location reads back in the owner's own words]");
    ok(locationLabel(after, after.rooms.id(r101._id)) === "Garden Block · Ground",
      `"${locationLabel(after, after.rooms.id(r101._id))}"`);
    ok(locationLabel(after, after.rooms.id(r102._id)) === "Garden Block", "a block-only room says just the block");
    ok(locationLabel(after, after.rooms.id(stray._id)) === "", "an unplaced room says nothing rather than inventing a place");

    console.log("\n[duplicate names are refused, per level]");
    ok((await call(blocks.addBlock, asOwner({ body: { name: "GARDEN BLOCK" } }))).code === 409, "a block name differing only in case → 409");
    ok((await call(blocks.addFloor, asOwner({ params: { blockId: String(garden._id) }, body: { name: "ground" } }))).code === 409, "a floor name already in THAT block → 409");
    ok((await call(blocks.addFloor, asOwner({ params: { blockId: String(noFloors.body.block._id) }, body: { name: "Ground" } }))).code === 201,
      "…but the same floor name in a DIFFERENT block is fine");
    ok((await call(blocks.addBlock, asOwner({ body: { name: "Twins", floors: ["A", "a"] } }))).code === 409, "two floors named the same in one create → 409");

    console.log("\n[scope]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Mysore", state: "Karnataka" });
    created.push(other._id);
    const intruder = { ...asOwner({ body: { name: "Theirs" } }), venueOwner: { type: "venue_owner", venueId: other._id, role: "owner" } };
    ok((await call(blocks.addBlock, intruder)).code === 403, "another venue's owner → 403");
    ok(!(await Venue.findById(venue._id)).blocks.some((b) => b.name === "Theirs"), "…and nothing was written");

    // ══ 5. STATUS, AND THE COUNTS THAT DISAGREED ════════════════════════════
    console.log("\n[the layout carries what each room IS, so Occupancy is not a separate view]");
    const withStatus = await call(blocks.getLayout, asOwner());
    const everyRoom = withStatus.body.layout.flatMap((b) => b.floors.flatMap((f) => f.rooms));
    ok(everyRoom.every((r) => typeof r.status === "string"), "every room on the layout carries a status");
    ok(everyRoom.every((r) => ["free", "occupied", "held", "inactive"].includes(r.status)),
      `…one of the four: ${[...new Set(everyRoom.map((r) => r.status))].join(", ")}`);
    ok(withStatus.body.counts.status.free === everyRoom.length,
      `all ${withStatus.body.counts.status.free} are free with nothing allotted`);

    console.log("\n[an occupied room, a held room, and a switched-off one are told apart]");
    const vs = await Venue.findById(venue._id);
    const roomA = vs.rooms.id(r101._id);
    const roomB = vs.rooms.id(r102._id);
    const roomOff = vs.rooms.id(r201._id);
    roomOff.isActive = false;
    await vs.save();

    const today = new Date();
    const midday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const bookingId = new mongoose.Types.ObjectId();
    const allot = await VenueRoomAllotment.create({
      venue: venue._id, booking: bookingId, room: roomA._id, guestName: "Bride's family",
      checkInAt: midday, checkOutAt: new Date(midday.getTime() + 2 * 86400000), status: "allotted",
    });
    madeAllotments.push(allot._id);
    // A HELD night — reserved at confirmation with no guest picked yet, which is
    // exactly the case an allotment-only read would show as free.
    const heldNight = await VenueRoomNight.create({
      venue: venue._id, room: roomB._id, night: midday, booking: bookingId, allotment: null,
    });
    madeNights.push(heldNight._id);

    const live = await call(blocks.getLayout, asOwner());
    ok(live.code === 200, `getLayout with live status → 200 (got ${live.code}${live.code !== 200 ? ": " + JSON.stringify(live.body) : ""})`);
    const byName = Object.fromEntries(
      live.body.layout.flatMap((b) => b.floors.flatMap((f) => f.rooms)).map((r) => [r.name, r])
    );
    ok(byName["101"].status === "occupied", `101 is occupied (got "${byName["101"].status}")`);
    ok(byName["101"].guestName === "Bride's family", `…and says who: ${byName["101"].guestName}`);
    ok(byName["102"].status === "held",
      `102 is HELD (got "${byName["102"].status}") — an allotment-only read would have called it free`);
    ok(byName["201"].status === "inactive",
      `a switched-off room is "inactive", not "free" — colouring it free is how one gets sold`);

    console.log("\n[ONE source for every count — the three that contradicted each other]");
    const c = live.body.counts;
    const roomsOnLayout = live.body.layout.reduce((n, b) => n + b.floors.reduce((m, f) => m + f.rooms.length, 0), 0);
    ok(c.rooms === roomsOnLayout, `counts.rooms (${c.rooms}) equals what the layout actually renders (${roomsOnLayout})`);
    ok(c.active + c.inactive === c.rooms, `active ${c.active} + inactive ${c.inactive} = ${c.rooms}`);
    const st = c.status;
    ok(st.free + st.occupied + st.held + st.inactive === c.rooms,
      `the status totals also sum to ${c.rooms} — "20 active rooms / Rooms · 21 / 20 rooms" cannot recur`);
    ok(st.inactive === c.inactive, `and inactive agrees between the two counts (${st.inactive})`);

    // ══ ROOMS 9 — THE LAYOUT CAN ONLY NAME AN AMENITY BECAUSE OF THIS ══════
    // ── A FAILING EXPECTATION, NOT A COMMENT ───────────────────────────────
    // The layout's CATEGORIES section renders each type's amenities by NAME.
    // It can only do that because GET /room-blocks carries `roomAmenities`
    // beside `roomTypes` — the types hold amenity KEYS, and without the library
    // the most specific thing the screen can say is how many there are. That is
    // exactly what it used to say: "10 amenities".
    //
    // The fix lives in the CLIENT, so nothing there would fail if this field
    // were dropped from the payload. The screen would just quietly go back to
    // counting. Asserted here so removing it is a red test rather than a
    // regression nobody notices.
    console.log("\n[the layout payload carries the amenity LIBRARY, not just the keys]");
    {
      const seeded = await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
      ok(seeded.code === 200, `seeded the amenity library (got ${seeded.code})`);
      const typed = await call(rt.addRoomType, asOwner({
        body: { name: "Named Amenities", sleeps: 2, amenities: ["ac", "wifi"] },
      }));
      ok(typed.code === 201, `a type with two amenities (got ${typed.code})`);

      const payload = (await call(blocks.getLayout, asOwner())).body;
      ok(Array.isArray(payload.roomAmenities) && payload.roomAmenities.length > 0,
        `GET /room-blocks carries roomAmenities (${(payload.roomAmenities || []).length} of them)`);

      // The real assertion: every key on every type RESOLVES to a label here.
      // A payload that carries the array but not the keys' entries is the same
      // bug wearing a different shape.
      const labels = new Map((payload.roomAmenities || []).map((a) => [String(a.key), a.label]));
      const mine = (payload.roomTypes || []).find((t) => t.name === "Named Amenities");
      ok(!!mine, "…and the type is on the layout payload");
      const resolved = (mine.amenities || []).map((k) => labels.get(String(k)));
      ok(resolved.length === 2 && resolved.every(Boolean),
        `…and every amenity key resolves to a label: ${resolved.join(", ")}`);
      ok(resolved.join(", ") === "Air conditioning, Wi-Fi",
        `…to the RIGHT labels, not just to something truthy (${resolved.join(", ")})`);

      // And the delete verdict rides on this read too — the drawer words its
      // button from it BEFORE anything is pressed.
      ok(mine.deleteAction === "delete",
        `a type with no rooms reports deleteAction "delete" (got ${mine.deleteAction})`);
      ok(mine.usage && Array.isArray(mine.usage.rooms) && mine.usage.rooms.length === 0,
        "…and usage.rooms is an empty list, not absent — the drawer counts from this, never from a local filter");
    }

    console.log("\n[validatePlacement on its own]");
    ok(validatePlacement(after, null, null).ok === true, "null/null is valid — a room may simply have no place");
    ok(validatePlacement(after, null, String(mg._id)).ok === false, "floor without block is not");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueRoomNight.deleteMany({ _id: { $in: madeNights } });
      await VenueRoomAllotment.deleteMany({ _id: { $in: madeAllotments } });
      await Venue.deleteMany({ _id: { $in: created } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();

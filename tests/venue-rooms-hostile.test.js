// ROOMS 12 — the product used like a hostile first-time owner. Run:
//   node tests/venue-rooms-hostile.test.js
//
// Every section is a sequence a real person does — the wrong order, the
// double-click, the delete-and-re-add — and asserts on the STORED document.
// The founder's Crown Estate case is section 1.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const blocks = require("../controllers/venueRoomBlocks");
const rooms = require("../controllers/venueRooms");
const rt = require("../controllers/venueRoomTypes");
const { resolveLayout } = require("../utils/venueRoomLayout");

const TAG = `hostile-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const created = [];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const slug = `${TAG}-v`;
    const venue = await Venue.create({ name: slug, slug, city: "Bangalore", state: "Karnataka" });
    created.push(venue._id);
    const req = (extra = {}) => ({
      params: { slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
    });
    const stored = async () => Venue.findById(venue._id).select("blocks rooms roomTypes").lean();

    // ══ 1. THE FOUNDER'S CASE ═════════════════════════════════════════════════
    console.log("\n[1. Crown Estate — bulk create with the floor left at its default]");
    let r = await call(blocks.addBlock, req({ body: { name: "Block A", floors: ["Ground", "First"] } }));
    eq(r.code, 201, "Block A with Ground and First");
    let v = await stored();
    const blockA = v.blocks[0];
    const first = blockA.floors.find((f) => f.name === "First");

    // The wizard's floor select defaults to "No floor". This is what it sends.
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "201", to: "204", blockRef: String(blockA._id) } }));
    eq(r.code, 201, "201–204 created with blockRef and NO floorRef");
    v = await stored();
    const misparented = v.rooms.filter((x) => String(x.blockRef) === String(blockA._id) && !x.floorRef);
    eq(misparented.length, 4, "🔴 all four are MIS-PARENTED — in the block, on no floor — not unplaced");
    const lay = resolveLayout(v);
    const implicit = lay.blocks[0].floors.find((f) => f.isImplicit);
    ok(implicit && implicit.rooms.length === 4, "🔴 …so they render on Block A's IMPLICIT floor, which is what the bare strip was");
    ok(!lay.blocks.some((b) => b.isUnplaced), "…and the 'Not placed yet' bucket does not appear, because they DO have a block");

    console.log("\n[…then the owner tries to add 201–204 to First]");
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "201", to: "204", blockRef: String(blockA._id), floorRef: String(first._id), preview: true } }));
    eq(r.code, 200, "preview answers");
    eq(r.body.willSkip.length, 4, "all four clash");
    const s0 = r.body.willSkip[0];
    ok(typeof s0.roomId === "string" && s0.roomId.length > 0, "🔴 each clash carries the ROOM ID, so the screen can offer to move it");
    ok(s0.at && s0.at.blockRef === String(blockA._id) && s0.at.floorRef === null,
      `🔴 …and WHERE it is: "${s0.at && s0.at.label}"`);
    eq(s0.alreadyHere, false, "🔴 …and that it is NOT already on First, so a move is meaningful");

    console.log("\n[…and moves them there in one action]");
    r = await call(blocks.placeRooms, req({ body: { roomIds: r.body.willSkip.map((s) => s.roomId), blockRef: String(blockA._id), floorRef: String(first._id) } }));
    eq(r.code, 200, "🔴 PATCH /rooms/place moves all four");
    v = await stored();
    eq(v.rooms.filter((x) => String(x.floorRef) === String(first._id)).length, 4, "🔴 STORED: all four now carry First's floorRef");
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "201", to: "204", blockRef: String(blockA._id), floorRef: String(first._id), preview: true } }));
    eq(r.body.willSkip.every((s) => s.alreadyHere), true, "…and a second attempt says they are ALREADY here rather than offering a no-op move");

    console.log("\n[a batch that half-exists offers to move only the ones elsewhere]");
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "203", to: "206", blockRef: String(blockA._id), floorRef: String(first._id), preview: true } }));
    eq(r.body.willCreate.length, 2, "205, 206 would be created");
    eq(r.body.willSkip.length, 2, "203, 204 clash");
    ok(r.body.willSkip.every((s) => s.alreadyHere), "…and both are already on First — nothing to move, only to skip");

    // ══ 2. DELETE A FLOOR, RE-ADD IT — THE IDENTITY CHAIN ═════════════════════
    console.log("\n[2. delete First, re-add First — nothing haunted]");
    const oldFirstId = String(first._id);
    r = await call(blocks.updateFloor, req({ params: { blockId: String(blockA._id), floorId: oldFirstId }, body: { isActive: false } }));
    eq(r.code, 200, "retire First");
    r = await call(blocks.deleteFloor, req({ params: { blockId: String(blockA._id), floorId: oldFirstId } }));
    eq(r.code, 409, "delete refuses while rooms are on it");
    ok(Array.isArray(r.body.rooms) && r.body.rooms.length === 4, "…naming the four rooms");
    r = await call(blocks.deleteFloor, req({ params: { blockId: String(blockA._id), floorId: oldFirstId }, query: { force: "1" } }));
    eq(r.code, 200, "forced delete succeeds");
    v = await stored();
    ok(v.rooms.every((x) => !x.floorRef || String(x.floorRef) !== oldFirstId), "🔴 no room still points at the DEAD floor id");
    r = await call(blocks.addFloor, req({ params: { blockId: String(blockA._id) }, body: { name: "First" } }));
    eq(r.code, 201, "re-add First");
    v = await stored();
    const newFirst = v.blocks[0].floors.find((f) => f.name === "First");
    ok(String(newFirst._id) !== oldFirstId, "the re-added First is a NEW id — a subdocument, as expected");
    const kept = v.rooms.filter((x) => String(x.blockRef) === String(blockA._id) && !x.floorRef);
    eq(kept.length, 4, "…and the four rooms stayed in Block A, on no floor");
    // The human then adds 201-204 to the new First. This must OFFER a move, not dead-end.
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "201", to: "204", blockRef: String(blockA._id), floorRef: String(newFirst._id), preview: true } }));
    ok(r.body.willSkip.length === 4 && r.body.willSkip.every((s) => !s.alreadyHere && s.at.floorRef === null),
      "🔴 re-adding to the NEW First finds them in the block on no floor, movable — the delete-and-re-add did not strand them");

    // ══ 3. DOUBLE-CLICK ═══════════════════════════════════════════════════════
    console.log("\n[3. double-click every create]");
    let [a, b] = await Promise.all([
      call(blocks.addBlock, req({ body: { name: "Block B" } })), call(blocks.addBlock, req({ body: { name: "Block B" } })),
    ]);
    v = await stored();
    eq(v.blocks.filter((x) => x.name === "Block B").length, 1, `🔴 two concurrent Add block → ONE stored (${a.code}/${b.code})`);
    const blockB = v.blocks.find((x) => x.name === "Block B");
    [a, b] = await Promise.all([
      call(blocks.addFloor, req({ params: { blockId: String(blockB._id) }, body: { name: "Ground" } })),
      call(blocks.addFloor, req({ params: { blockId: String(blockB._id) }, body: { name: "Ground" } })),
    ]);
    v = await stored();
    eq(v.blocks.find((x) => x.name === "Block B").floors.filter((f) => f.name === "Ground").length, 1, `🔴 two concurrent Add floor → ONE stored (${a.code}/${b.code})`);
    [a, b] = await Promise.all([
      call(rt.addRoomType, req({ body: { name: "Suite", bedsSleep: 2 } })), call(rt.addRoomType, req({ body: { name: "Suite", bedsSleep: 2 } })),
    ]);
    v = await stored();
    eq(v.roomTypes.filter((t) => t.name === "Suite").length, 1, `🔴 two concurrent Add type → ONE stored (${a.code}/${b.code})`);
    [a, b] = await Promise.all([
      call(rooms.bulkCreateRooms, req({ body: { from: "301", to: "303", blockRef: String(blockB._id) } })),
      call(rooms.bulkCreateRooms, req({ body: { from: "301", to: "303", blockRef: String(blockB._id) } })),
    ]);
    v = await stored();
    eq(v.rooms.filter((x) => ["301", "302", "303"].includes(x.name)).length, 3, `two concurrent bulk create → three rooms, no dupes (${a.code}/${b.code})`);

    console.log("\n[…and the atomic guard still dedupes the human ways]");
    r = await call(blocks.addBlock, req({ body: { name: "  block b " } }));
    eq(r.code, 409, "padded, lower-cased re-add of Block B is refused");
    r = await call(blocks.addBlock, req({ body: { name: "Wing (C) + Annexe" } }));
    eq(r.code, 201, "a name with regex characters is created");
    r = await call(blocks.addBlock, req({ body: { name: "Wing (C) + Annexe" } }));
    eq(r.code, 409, "…and refused the second time — the characters did not break the guard");

    // ══ 4. DELETE ROOMS, RE-ADD THE SAME NUMBERS ══════════════════════════════
    console.log("\n[4. delete rooms, re-add the same numbers immediately]");
    v = await stored();
    const r301 = v.rooms.find((x) => x.name === "301");
    r = await call(rooms.updateRoom, req({ params: { roomId: String(r301._id) }, body: { isActive: false } }));
    eq(r.code, 200, "deactivate 301");
    r = await call(rooms.deleteRoom, req({ params: { roomId: String(r301._id) } }));
    eq(r.code, 200, "delete 301");
    r = await call(rooms.bulkCreateRooms, req({ body: { from: "301", to: "301", blockRef: String(blockB._id) } }));
    eq(r.code, 201, "🔴 301 can be re-created immediately — nothing haunted");
    v = await stored();
    eq(v.rooms.filter((x) => x.name === "301").length, 1, "…exactly one 301 stored");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try { await Venue.deleteMany({ _id: { $in: created } }); } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();

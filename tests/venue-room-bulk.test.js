// ROOMS 2 / slice 3 — bulk room creation, and what happens when a name is taken.
//
// The requirement is specific: creating 101–110 when 105 exists should SAY SO
// and offer to skip. Never fail the whole batch, never overwrite silently. So
// the suite spends most of its assertions on the collision path, and on the two
// wrong answers that look right:
//
//   · skipping quietly — the owner believes they made ten and has nine
//   · failing the batch — nine good rooms lost to one clash they did not know of
//
// It also holds the preview and the apply to the same plan: if those two ever
// disagree, the owner approves one thing and gets another.
//
// Run: node tests/venue-room-bulk.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const rt = require("../controllers/venueRoomTypes");
const rooms = require("../controllers/venueRooms");
const { MAX_BATCH, expandRange } = require("../utils/venueRoomBulk");

const TAG = `rb-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = [];
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

let venueId, slug;
const asOwner = (extra = {}) => ({
  params: { slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId, role: "owner" },
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const allRooms = async () => (await call(rooms.listRooms, asOwner())).body.rooms;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG} Resort`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      accommodation: { available: true },
    });
    created.push(venue._id);
    venueId = venue._id; slug = venue.slug;

    await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
    const deluxe = (await call(rt.addRoomType, asOwner({
      body: { name: "Deluxe", sleeps: 2, maxOccupancy: 3, defaultRate: 4500, amenities: ["ac", "wifi"] },
    }))).body.roomType;
    const standard = (await call(rt.addRoomType, asOwner({
      body: { name: "Standard", sleeps: 2, defaultRate: 2500, amenities: ["ac"] },
    }))).body.roomType;

    // ══ 1. THE CLEAN BATCH ══════════════════════════════════════════════════
    console.log("\n[a floor at a time]");
    const preview = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), from: 101, to: 110, preview: true },
    }));
    ok(preview.code === 200 && preview.body.preview === true, `preview → 200 (got ${preview.code})`);
    ok(preview.body.willCreate.length === 10 && preview.body.willSkip.length === 0, "…10 to create, nothing to skip");
    ok((await allRooms()).length === 0, "…and the preview wrote NOTHING");

    const batch1 = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), from: 101, to: 110 },
    }));
    ok(batch1.code === 201, `create 101–110 → 201 (got ${batch1.code})`);
    ok(batch1.body.createdCount === 10, `…10 rooms created (got ${batch1.body.createdCount})`);
    ok(JSON.stringify(batch1.body.created) === JSON.stringify(preview.body.willCreate),
      "…and the applied batch is exactly what the preview promised");

    const after1 = await allRooms();
    ok(after1.length === 10 && after1[0].name === "101" && after1[9].name === "110", `named 101…110 (${after1[0].name}…${after1[9].name})`);
    ok(after1.every((r) => r.rate === 4500 && r.capacity === 2), "…every one inheriting the type's rate and capacity");
    ok(after1.every((r) => r.overrides.length === 0), "…and none of them claiming a field as its own");
    ok(batch1.body.accommodation.roomTypes.find((r) => r.name === "Deluxe").count === 10,
      "…and the public listing's Deluxe count went straight to 10");

    const batch2 = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(standard._id), from: 201, to: 212 },
    }));
    ok(batch2.code === 201 && batch2.body.createdCount === 12, `a second floor, 201–212 → 12 rooms (got ${batch2.body.createdCount})`);
    ok(batch2.body.accommodation.roomTypes.find((r) => r.name === "Standard").count === 12, "…counted against Standard, not Deluxe");

    // ══ 2. THE COLLISION — THE POINT OF THE SLICE ═══════════════════════════
    console.log("\n[101–110 again, with 105 already there]");
    const clash = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), from: 105, to: 115 },
    }));
    ok(clash.code === 409, `→ 409, refused ONCE rather than half-done (got ${clash.code})`);
    ok(clash.body.code === "bulk_collision", "…with a code the UI can branch on");
    ok(clash.body.willSkip.length === 6 && clash.body.willCreate.length === 5,
      `…naming 6 that exist and 5 that do not (got ${clash.body.willSkip.length}/${clash.body.willCreate.length})`);
    ok(clash.body.willSkip.map((s) => s.name).join(",") === "105,106,107,108,109,110",
      `…and saying WHICH: ${clash.body.willSkip.map((s) => s.name).join(", ")}`);
    ok(/6 of these already exist/.test(clash.body.message), `…in a sentence an owner can act on: "${clash.body.message}"`);
    ok(/onCollision/.test(clash.body.hint || ""), "…and telling them exactly how to proceed");
    ok((await allRooms()).length === 22, "…having created NOTHING — the refusal is total, not partial");

    console.log("\n[the owner accepts, and gets the other five]");
    const resolved = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), from: 105, to: 115, onCollision: "skip" },
    }));
    ok(resolved.code === 201, `→ 201 (got ${resolved.code})`);
    ok(resolved.body.createdCount === 5, `…5 created (got ${resolved.body.createdCount})`);
    ok(resolved.body.skipped.length === 6, `…6 reported as skipped, not swallowed (got ${resolved.body.skipped.length})`);
    ok(resolved.body.created.join(",") === "111,112,113,114,115", `…the right five: ${resolved.body.created.join(", ")}`);

    console.log("\n[and 105 was not touched]");
    const room105 = (await allRooms()).find((r) => r.name === "105");
    await call(rooms.updateRoom, asOwner({ params: { roomId: String(room105._id) }, body: { rate: 7777, notes: "corner room" } }));
    const reclash = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(standard._id), from: 105, to: 105, onCollision: "skip" },
    }));
    ok(reclash.code === 409 && reclash.body.code === "bulk_all_exist", `re-creating only 105 → 409 bulk_all_exist (got ${reclash.code})`);
    const still105 = (await allRooms()).find((r) => r.name === "105");
    ok(still105.rate === 7777 && still105.notes === "corner room", `…and 105 kept its rate ${still105.rate} and note — never overwritten`);
    ok(String(still105.typeRef) === String(deluxe._id), "…and stayed Deluxe rather than being reassigned to Standard");

    // ══ 3. THE INACTIVE ROOM STILL OWNS ITS NAME ════════════════════════════
    console.log("\n[a switched-off room still owns its name]");
    const room110 = (await allRooms()).find((r) => r.name === "110");
    await call(rooms.updateRoom, asOwner({ params: { roomId: String(room110._id) }, body: { isActive: false } }));
    const ghost = await call(rooms.bulkCreateRooms, asOwner({ body: { typeRef: String(deluxe._id), from: 110, to: 110 } }));
    ok(ghost.code === 409, `creating 110 again → 409 (got ${ghost.code})`);
    ok(ghost.body.willSkip[0].reason === "exists_inactive", "…flagged as inactive rather than just 'exists'");
    ok(/switched off/.test(ghost.body.willSkip[0].message), `…so the owner knows to turn it back on: "${ghost.body.willSkip[0].message}"`);
    const names110 = (await allRooms()).filter((r) => r.name === "110");
    ok(names110.length === 1, "…and there is exactly one room called 110, not a visible one and a hidden one");
    await call(rooms.updateRoom, asOwner({ params: { roomId: String(room110._id) }, body: { isActive: true } }));

    // ══ 4. NAMED ROOMS, NOT JUST NUMBERS ════════════════════════════════════
    console.log("\n[venues that name rooms rather than number them]");
    const named = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), names: "Lakeview Cottage, Rose Cottage\nJasmine Cottage" },
    }));
    ok(named.code === 201 && named.body.createdCount === 3, `a comma/newline list → 3 rooms (got ${named.body.createdCount})`);
    ok((await allRooms()).some((r) => r.name === "Jasmine Cottage"), "…including the one after the newline");

    const dupInBatch = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(deluxe._id), names: ["Tent A", "Tent B", "tent a"] },
    }));
    ok(dupInBatch.code === 409 && dupInBatch.body.willSkip[0].reason === "duplicate_in_batch",
      `the same name twice in one batch → caught (got ${dupInBatch.code}/${(dupInBatch.body.willSkip[0] || {}).reason})`);
    ok(/listed twice/.test(dupInBatch.body.willSkip[0].message), "…and named as a batch duplicate, not as an existing room");

    // ══ 5. RANGES THAT ARE NOT WHAT THEY LOOK LIKE ══════════════════════════
    console.log("\n[ranges]");
    ok(expandRange({ from: "007", to: "011" }).names.join(",") === "007,008,009,010,011",
      "007–011 keeps its padding — a venue whose rooms are called 007 does not want 7");
    ok(expandRange({ from: 7, to: 11 }).names.join(",") === "7,8,9,10,11", "…while a bare 7–11 does not gain padding it never had");
    const backwards = await call(rooms.bulkCreateRooms, asOwner({ body: { from: 110, to: 101 } }));
    ok(backwards.code === 400 && /runs backwards/.test(backwards.body.message), `110→101 → 400 (got ${backwards.code})`);
    const huge = await call(rooms.bulkCreateRooms, asOwner({ body: { from: 1, to: 5000 } }));
    ok(huge.code === 400 && new RegExp(`batches of ${MAX_BATCH}`).test(huge.body.message), `5000 rooms → 400 (got ${huge.code})`);
    const neither = await call(rooms.bulkCreateRooms, asOwner({ body: {} }));
    ok(neither.code === 400 && /range \(from\/to\) or a list/.test(neither.body.message), "neither a range nor a list → 400");

    console.log("\n[a bad type fails on nothing, not on half a floor]");
    const badType = await call(rooms.bulkCreateRooms, asOwner({
      body: { typeRef: String(new mongoose.Types.ObjectId()), from: 301, to: 310 },
    }));
    ok(badType.code === 400, `an unknown type → 400 (got ${badType.code})`);
    ok(!(await allRooms()).some((r) => r.name === "301"), "…and not one room of that floor was created");

    // ══ 6. BULK ROOMS ARE NORMAL ROOMS ══════════════════════════════════════
    console.log("\n[nothing about a bulk room is special afterwards]");
    const r107 = (await allRooms()).find((r) => r.name === "107");
    await call(rt.updateRoomType, asOwner({ params: { typeId: String(deluxe._id) }, body: { defaultRate: 5200 } }));
    const r107after = (await allRooms()).find((r) => r.name === "107");
    ok(r107after.rate === 5200, `a bulk-created room follows a later type edit (got ${r107after.rate})`);
    ok(r107.rate === 4500 && r107after.fields.rate.source === "type", "…and still reports the type as its source");
    const r105after = (await allRooms()).find((r) => r.name === "105");
    ok(r105after.rate === 7777, "…while the one that was overridden stayed at 7777");

    // ══ 7. SCOPE ════════════════════════════════════════════════════════════
    console.log("\n[another venue's owner cannot bulk-create here]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Mysore", state: "Karnataka" });
    created.push(other._id);
    const intruder = { ...asOwner({ body: { from: 401, to: 410 } }), venueOwner: { type: "venue_owner", venueId: other._id, role: "owner" } };
    const denied = await call(rooms.bulkCreateRooms, intruder);
    ok(denied.code === 403, `→ 403 (got ${denied.code})`);
    ok(!(await allRooms()).some((r) => r.name === "401"), "…and nothing was written");
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

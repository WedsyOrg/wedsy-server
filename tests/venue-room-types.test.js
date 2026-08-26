// ROOMS 2 / slice 1 — the room TYPE as a real entity, and the derived listing.
//
// The thing this suite exists to protect is the couple-facing listing. It reads
// accommodation.roomTypes today; after this build that block is DERIVED. So the
// assertions are not "the projection produced some rows" but "the expressions
// wedsy-user/pages/venues/[slug].js actually evaluates produce the same numbers
// they produce now".
//
// Those expressions are reproduced verbatim in renderListing() below, from
// [slug].js:879-883 and 1686-1700. If the page changes, this suite should be
// updated to match it — that is the point of copying it rather than importing
// a shared helper the page does not use.
//
// Every write goes through the CONTROLLER with a real request shape. Rows are
// never hand-built: a wizard blocker shipped once because a suite constructed
// rows no caller sends.
//
// Run: node tests/venue-room-types.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const rt = require("../controllers/venueRoomTypes");
const rooms = require("../controllers/venueRooms");
const VenueService = require("../services/VenueService");
const {
  DEFAULT_ROOM_AMENITIES,
  projectAccommodation,
  resolveRooms,
} = require("../utils/venueRoomTypes");

const TAG = `rt-${Date.now()}`;
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

// ── the listing, as wedsy-user/pages/venues/[slug].js computes it ────────────
function renderListing(acc) {
  const a = acc || {};
  const accRoomTypes = a.roomTypes || [];                                   // :880
  const accTotalRooms = accRoomTypes.reduce((sum, r) => sum + (Number(r.count) || 0), 0);   // :881
  const accTotalCap = Number(a.totalCapacity) ||                            // :883
    accRoomTypes.reduce((sum, r) => sum + ((Number(r.count) || 0) * ((Number(r.maxPeoplePerRoom) || Number(r.occupancyPerRoom)) || 0)), 0);
  return {
    showsAccommodation: a.available === true,                               // :940
    accTotalRooms,
    accTotalCap,
    rows: accRoomTypes.map((r) => ({
      name: r.name, count: r.count, occupancyPerRoom: r.occupancyPerRoom,
      maxPeoplePerRoom: r.maxPeoplePerRoom, pricePerNight: r.pricePerNight,
      isAC: r.isAC, description: r.description || "",
    })),
  };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ 1. THE OPT-IN GATE ══════════════════════════════════════════════════
    console.log("\n[a venue that has NOT adopted types keeps its hand-written block untouched]");
    const legacy = await Venue.create({
      name: `${TAG} Legacy`, slug: `${TAG}-legacy`, city: "Bangalore", state: "Karnataka",
      accommodation: {
        available: true,
        roomTypes: [{ name: "Standard", count: 16, occupancyPerRoom: 2, maxPeoplePerRoom: 3, pricePerNight: 0, isAC: true, description: "16 rooms." }],
      },
    });
    created.push(legacy._id);
    const legacyBefore = JSON.stringify(renderListing(legacy.accommodation));
    const skipped = projectAccommodation(legacy);
    ok(skipped.changed === false && skipped.skipped === "no-room-types", "projection declines to run without roomTypes[]");
    ok(JSON.stringify(renderListing(legacy.accommodation)) === legacyBefore, "…and the listing block is byte-identical");
    const lv = renderListing(legacy.accommodation);
    ok(lv.accTotalRooms === 16 && lv.accTotalCap === 48, `…rendering 16 rooms / 48 guests, as today (got ${lv.accTotalRooms}/${lv.accTotalCap})`);

    // ══ 2. ADOPTION THROUGH THE REAL WRITE PATH ═════════════════════════════
    console.log("\n[a venue adopts types — every write below is a controller call]");
    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      accommodation: { available: true },
      roomAmenities: DEFAULT_ROOM_AMENITIES.map((a) => ({ ...a, isActive: true })),
    });
    created.push(venue._id);
    venueId = venue._id; slug = venue.slug;

    const mkType = await call(rt.addRoomType, asOwner({
      body: { name: "Deluxe", sleeps: 2, maxOccupancy: 3, defaultRate: 4500, description: "Garden facing.", amenities: ["ac", "wifi"] },
    }));
    ok(mkType.code === 201, `POST room-types → 201 (got ${mkType.code})`);
    const deluxe = mkType.body.roomType;
    ok(mkType.body.accommodation.roomTypes.length === 1, "the accommodation block gained the derived row immediately");
    ok(mkType.body.accommodation.roomTypes[0].count === 0, "…with count 0, because no rooms exist yet — the count is real, not typed");

    const mkType2 = await call(rt.addRoomType, asOwner({
      body: { name: "Cottage", sleeps: 4, defaultRate: 8000, amenities: ["ac", "balcony", "hot_water"] },
    }));
    ok(mkType2.code === 201, `a second type → 201 (got ${mkType2.code})`);
    const cottage = mkType2.body.roomType;

    console.log("\n[input the type refuses]");
    const dup = await call(rt.addRoomType, asOwner({ body: { name: "deluxe", sleeps: 2 } }));
    ok(dup.code === 409, `a name that only differs in case → 409 (got ${dup.code})`);
    const badMax = await call(rt.addRoomType, asOwner({ body: { name: "Broken", sleeps: 4, maxOccupancy: 2 } }));
    ok(badMax.code === 400, `maxOccupancy below sleeps → 400 (got ${badMax.code})`);
    ok(/cannot be below/.test((badMax.body || {}).message || ""), "…and says which way round it should be");
    const badAmenity = await call(rt.addRoomType, asOwner({ body: { name: "Jacuzzi Suite", amenities: ["jacuzzi"] } }));
    ok(badAmenity.code === 400, `an amenity key not in the venue's library → 400 (got ${badAmenity.code})`);
    ok(/not in this venue's amenity list/.test((badAmenity.body || {}).message || ""), "…and points the owner at the list to fix it");

    // ══ 3. ROOMS BELONG TO A TYPE, AND THE COUNT FOLLOWS REALITY ════════════
    console.log("\n[rooms attach to a type and the derived count follows them]");
    for (const n of [101, 102, 103]) {
      const r = await call(rooms.addRoom, asOwner({ body: { name: String(n), typeRef: String(deluxe._id) } }));
      ok(r.code === 201, `room ${n} created (got ${r.code})`);
    }
    const cot = await call(rooms.addRoom, asOwner({ body: { name: "Lakeview Cottage", typeRef: String(cottage._id) } }));
    ok(cot.code === 201, `a named cottage created (got ${cot.code})`);
    const orphan = await call(rooms.addRoom, asOwner({ body: { name: "Store Room" } }));
    ok(orphan.code === 201, "a room with no type is allowed — one-offs exist");

    let state = await call(rt.listRoomTypes, asOwner());
    let byName = Object.fromEntries(state.body.accommodation.roomTypes.map((r) => [r.name, r]));
    ok(byName.Deluxe.count === 3, `Deluxe derives count 3 from real rooms (got ${byName.Deluxe.count})`);
    ok(byName.Cottage.count === 1, `Cottage derives count 1 (got ${byName.Cottage.count})`);
    ok(state.body.untypedRooms === 1, `the untyped room is REPORTED (${state.body.untypedRooms}), not folded into a row nobody wrote`);
    ok(state.body.accommodation.roomTypes.length === 2, "…and no third 'Other' row appeared on the public listing");

    console.log("\n[the derived block renders correctly on the couple-facing page]");
    let view = renderListing(state.body.accommodation);
    ok(view.showsAccommodation === true, "the accommodation section still shows");
    ok(view.accTotalRooms === 4, `\"4 rooms\" (got ${view.accTotalRooms}) — the untyped store room is excluded, as it should be`);
    ok(view.accTotalCap === 3 * 3 + 1 * 4, `\"${3 * 3 + 1 * 4} guests\" (got ${view.accTotalCap}) — 3 Deluxe at max 3, 1 Cottage at 4`);
    ok(view.rows[0].pricePerNight === 4500, "the type's defaultRate reaches the listing as pricePerNight");
    ok(view.rows[0].isAC === true && view.rows[0].description === "Garden facing.", "isAC comes from the amenity set; the description carries through");

    console.log("\n[the totalCapacity written matches what the page would have derived anyway]");
    const stored = Number(state.body.accommodation.totalCapacity);
    const derivedIfAbsent = renderListing({ ...state.body.accommodation.toObject ? state.body.accommodation.toObject() : state.body.accommodation, totalCapacity: 0 }).accTotalCap;
    ok(stored === derivedIfAbsent, `stored ${stored} === the page's own fallback ${derivedIfAbsent} — so the number on screen cannot move`);

    console.log("\n[deactivating a room lowers the count; it does not delete history]");
    const roomsNow = (await call(rooms.listRooms, asOwner())).body.rooms;
    const room102 = roomsNow.find((r) => r.name === "102");
    const deact = await call(rooms.updateRoom, asOwner({ params: { roomId: String(room102._id) }, body: { isActive: false } }));
    ok(deact.code === 200, `PATCH room isActive:false → 200 (got ${deact.code})`);
    state = await call(rt.listRoomTypes, asOwner());
    byName = Object.fromEntries(state.body.accommodation.roomTypes.map((r) => [r.name, r]));
    ok(byName.Deluxe.count === 2, `Deluxe now derives 2 (got ${byName.Deluxe.count}) — the listing stops advertising a room that is out of service`);
    const reactivate = await call(rooms.updateRoom, asOwner({ params: { roomId: String(room102._id) }, body: { isActive: true } }));
    ok(reactivate.code === 200 && (await call(rt.listRoomTypes, asOwner())).body.accommodation.roomTypes.find((r) => r.name === "Deluxe").count === 3, "…and back to 3 when it returns");

    // ══ 4. `available` IS THE OWNER'S, NOT DERIVED ══════════════════════════
    console.log("\n[`available` stays the owner's toggle]");
    await Venue.updateOne({ _id: venueId }, { $set: { "accommodation.available": false } });
    const afterToggle = await call(rt.addRoomType, asOwner({ body: { name: "Tent", sleeps: 2 } }));
    ok(afterToggle.code === 201, "a room-type write succeeds with accommodation turned off");
    const reread = await Venue.findById(venueId).select("accommodation");
    ok(reread.accommodation.available === false, "…and did NOT silently re-advertise accommodation the owner had switched off");
    await Venue.updateOne({ _id: venueId }, { $set: { "accommodation.available": true } });
    const tentType = afterToggle.body.roomTypes.find((t) => t.name === "Tent");

    // ══ 5. ONE SOURCE OF TRUTH ══════════════════════════════════════════════
    console.log("\n[My Listing can no longer write the derived block]");
    await VenueService.updateVenueBySlug(slug, venueId, {
      accommodation: { available: true, totalCapacity: 9999, roomTypes: [{ name: "Hand typed", count: 500, occupancyPerRoom: 2, maxPeoplePerRoom: 2 }] },
    });
    const afterListingSave = await Venue.findById(venueId).select("accommodation");
    const names = afterListingSave.accommodation.roomTypes.map((r) => r.name);
    ok(!names.includes("Hand typed"), `the hand-typed row was refused (rows: ${names.join(", ")})`);
    ok(Number(afterListingSave.accommodation.totalCapacity) !== 9999, "…and totalCapacity was not overwritten with a typed number");
    ok(afterListingSave.accommodation.available === true, "…while `available`, which is genuinely the owner's, still saved");

    // ══ 6. DELETING A TYPE THAT ROOMS BELONG TO ═════════════════════════════
    // ROOMS 9: this used to assert a 409 and a "move them or deactivate this
    // one" message — advice pointing at a control that existed in no UI, while
    // PATCH {isActive:false} was accepted with no caller. A type now RETIRES
    // when it is in use and GOES when it is not, which is what rooms and
    // amenities already did. See controllers/venueRoomTypes.deleteRoomType.
    console.log("\n[a type with rooms retires rather than vanishing]");
    const retire = await call(rt.deleteRoomType, asOwner({ params: { typeId: String(deluxe._id) } }));
    ok(retire.code === 200, `DELETE a type with 3 rooms → 200 (got ${retire.code})`);
    ok(retire.body.retired === true && !retire.body.deleted, "…and says RETIRED, not deleted — the caller asked to delete and must be able to tell it did not");
    ok(/3 rooms are this type/.test((retire.body || {}).message || ""), `…naming the count: "${(retire.body || {}).message}"`);
    ok(((retire.body.usage || {}).rooms || []).length === 3, "…and listing which rooms, so the owner can act on it");

    // Read the STORED document, not the response body.
    const afterRetire = await Venue.findById(venueId).select("roomTypes rooms");
    const storedDeluxe = afterRetire.roomTypes.id(deluxe._id);
    ok(storedDeluxe && storedDeluxe.isActive === false, "the type is still there, switched off — assert the positive, not an absence");
    ok(afterRetire.rooms.filter((r) => String(r.typeRef || "") === String(deluxe._id)).length === 3,
      "…and its 3 rooms still point at it, because retiring is not detaching");

    // The founder's question: does a room still inherit from a RETIRED type?
    // It must — the alternative is three rooms silently reverting to defaults
    // the moment an owner tidies a type away.
    const stillInherits = (await call(rt.listRoomTypes, asOwner())).body.rooms
      .filter((r) => String(r.typeRef || "") === String(deluxe._id));
    ok(stillInherits.length === 3 && stillInherits.every((r) => Number(r.rate) === 4500 && Number(r.capacity) === 2),
      `…and all 3 still inherit the retired type's rate/capacity (${stillInherits.map((r) => r.rate).join(",")})`);

    // A retired type is not an assignment target, though — that guard is at the
    // write, in venueRooms.validateRoomInput.
    const ontoRetired = await call(rooms.updateRoom, asOwner({ params: { roomId: String(room102._id) }, body: { typeRef: String(deluxe._id) } }));
    ok(ontoRetired.code === 400 && /no longer an active room type/.test((ontoRetired.body || {}).message || ""),
      `a retired type refuses NEW rooms (got ${ontoRetired.code}: "${(ontoRetired.body || {}).message}")`);

    // Pressing delete again on an already-retired, still-used type must not read
    // as though it did something new.
    const retireAgain = await call(rt.deleteRoomType, asOwner({ params: { typeId: String(deluxe._id) } }));
    ok(retireAgain.code === 200 && /was already switched off/.test((retireAgain.body || {}).message || ""),
      `…and a second press says it was already off, rather than retiring it twice: "${(retireAgain.body || {}).message}"`);

    // Back on, so the rest of this suite runs against a live type.
    const revive = await call(rt.updateRoomType, asOwner({ params: { typeId: String(deluxe._id) }, body: { isActive: true } }));
    ok(revive.code === 200 && (await Venue.findById(venueId).select("roomTypes")).roomTypes.id(deluxe._id).isActive !== false,
      "a retired type can be switched back on — the control the old 409 advised now exists");

    const emptyDelete = await call(rt.deleteRoomType, asOwner({ params: { typeId: String(tentType._id) } }));
    ok(emptyDelete.code === 200 && emptyDelete.body.deleted === true, `a type with no rooms deletes cleanly (got ${emptyDelete.code})`);
    ok(!(await Venue.findById(venueId).select("roomTypes")).roomTypes.id(tentType._id), "…and is genuinely gone from the stored document");

    console.log("\n[forcing it freezes what the rooms had inherited]");
    const forced = await call(rt.deleteRoomType, asOwner({ params: { typeId: String(cottage._id) }, query: { force: "1" } }));
    ok(forced.code === 200 && forced.body.detached === 1, `force detaches the cottage (got ${forced.code}, detached ${forced.body && forced.body.detached})`);
    const survivor = (await Venue.findById(venueId).select("rooms")).rooms.find((r) => r.name === "Lakeview Cottage");
    ok(!survivor.typeRef, "the room survived with no type");
    ok(Number(survivor.rate) === 8000 && Number(survivor.capacity) === 4, `…keeping the rate ${survivor.rate} and capacity ${survivor.capacity} it had, rather than silently reverting to defaults`);
    ok(["capacity", "rate", "amenities"].every((f) => survivor.overrides.includes(f)), "…marked as its own on every inherited field, so nothing re-inherits from a type that is gone");

    console.log("\n[…and re-typing that room adopts the new type, rather than staying frozen]");
    const rejoin = await call(rooms.updateRoom, asOwner({ params: { roomId: String(survivor._id) }, body: { typeRef: String(deluxe._id) } }));
    ok(rejoin.code === 200, `PATCH the detached cottage onto Deluxe → 200 (got ${rejoin.code})`);
    ok(rejoin.body.room.rate === 4500 && rejoin.body.room.capacity === 2, `…it now reads Deluxe's rate ${rejoin.body.room.rate} and capacity ${rejoin.body.room.capacity}, not its frozen 8000/4`);
    ok(rejoin.body.room.overrides.length === 0, "…because the freeze stamp was a freeze, not a choice, and did not outlive the room having a type");
    const backOff = await call(rooms.updateRoom, asOwner({ params: { roomId: String(survivor._id) }, body: { rate: 9500 } }));
    ok(backOff.body.room.overrides.includes("rate") && backOff.body.room.rate === 9500, "a deliberate rate IS recorded as an override");
    const moved = await call(rooms.updateRoom, asOwner({ params: { roomId: String(survivor._id) }, body: { typeRef: String(deluxe._id), name: "Lakeview" } }));
    ok(moved.body.room.rate === 9500 && moved.body.room.overrides.includes("rate"), "…and survives a later type assignment, because that one WAS chosen");

    // ══ 7. SCOPE ════════════════════════════════════════════════════════════
    console.log("\n[a different venue's owner cannot touch any of it]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Mysore", state: "Karnataka" });
    created.push(other._id);
    const asIntruder = (extra = {}) => ({ ...asOwner(extra), venueOwner: { type: "venue_owner", venueId: other._id, role: "owner" } });
    for (const [name, fn, req] of [
      ["GET room-types", rt.listRoomTypes, asIntruder()],
      ["POST room-types", rt.addRoomType, asIntruder({ body: { name: "Theirs", sleeps: 2 } })],
      ["PATCH room-types/:id", rt.updateRoomType, asIntruder({ params: { typeId: String(deluxe._id) }, body: { defaultRate: 1 } })],
      ["DELETE room-types/:id", rt.deleteRoomType, asIntruder({ params: { typeId: String(deluxe._id) } })],
    ]) {
      const r = await call(fn, req);
      ok(r.code === 403, `${name} → 403 (got ${r.code})`);
    }
    const untouched = await Venue.findById(venueId).select("roomTypes");
    ok(!untouched.roomTypes.some((t) => t.name === "Theirs"), "…and nothing was written");
    ok(Number(untouched.roomTypes.id(deluxe._id).defaultRate) === 4500, "…the Deluxe rate is still 4500");

    // ══ 8. resolveRooms IS WHAT CALLERS READ ════════════════════════════════
    console.log("\n[resolveRooms reports inheritance, so no caller has to guess]");
    const full = await Venue.findById(venueId);
    const resolved = resolveRooms(full);
    const r101 = resolved.find((r) => r.name === "101");
    ok(r101.capacity === 2 && r101.rate === 4500, `101 reads its type's values (capacity ${r101.capacity}, rate ${r101.rate})`);
    ok(r101.inherited.includes("rate") && r101.overrides.length === 0, "…and says they are inherited, not its own");
    ok(r101.typeName === "Deluxe", "…and carries the type's name for display");
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

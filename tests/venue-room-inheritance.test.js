// ROOMS 2 / slice 2 — the amenities library, and inheritance with overrides.
//
// The rule under test: EDITING A TYPE UPDATES EVERY ROOM OF THAT TYPE EXCEPT
// THE FIELDS A ROOM HAS OVERRIDDEN. Two halves, and the second is the one that
// breaks silently:
//
//   · the cascade reaches rooms that did NOT diverge
//   · the cascade does NOT reach the one that did — and the owner can SEE why,
//     with the type's value beside the room's, and can put it back
//
// The suite deliberately edits a type to a value a room already holds, and then
// edits it away again. That is the case value-comparison would get wrong: a
// room whose 3 was inherited looks identical to a room whose 3 was chosen.
//
// Every write goes through the CONTROLLER with a real request shape.
//
// Run: node tests/venue-room-inheritance.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const rt = require("../controllers/venueRoomTypes");
const rooms = require("../controllers/venueRooms");

const TAG = `ri-${Date.now()}`;
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
const roomNamed = async (name) => (await call(rooms.listRooms, asOwner())).body.rooms.find((r) => r.name === name);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG} Estate`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      accommodation: { available: true },
    });
    created.push(venue._id);
    venueId = venue._id; slug = venue.slug;

    // ══ 1. THE LIBRARY ══════════════════════════════════════════════════════
    console.log("\n[the library starts empty and is seeded, not fixed]");
    let lib = await call(rt.listRoomAmenities, asOwner());
    ok(lib.code === 200 && lib.body.roomAmenities.length === 0, "a new venue has no room amenities");
    ok(lib.body.suggestions.length > 0, `…and is offered a starting set of ${lib.body.suggestions.length} to seed`);

    const seeded = await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
    ok(seeded.code === 200 && seeded.body.seeded === 10, `seeding adds the starting set (${seeded.body.seeded})`);
    const reseed = await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
    ok(reseed.code === 200 && reseed.body.seeded === 0, "seeding twice adds nothing — it is additive and idempotent");

    console.log("\n[the owner extends it with something the list never anticipated]");
    const custom = await call(rt.addRoomAmenity, asOwner({ body: { label: "Private plunge pool" } }));
    ok(custom.code === 201, `a custom amenity → 201 (got ${custom.code})`);
    ok(custom.body.amenity.key === "private_plunge_pool", `…with a machine key derived from the label (${custom.body.amenity.key})`);
    const dupA = await call(rt.addRoomAmenity, asOwner({ body: { label: "Private Plunge Pool" } }));
    ok(dupA.code === 409, `the same thing in different case → 409 (got ${dupA.code})`);

    console.log("\n[this list is NOT venue.amenities, and the reasons are checkable]");
    const propertyAmenityKeys = Object.keys(Venue.schema.paths)
      .filter((p) => p.startsWith("amenities."))
      .map((p) => p.slice("amenities.".length));
    ok(propertyAmenityKeys.includes("helipad") && propertyAmenityKeys.includes("liquorLicense"),
      "venue.amenities describes the PROPERTY (helipad, liquorLicense) — not a room");
    // The two lists DO share a word — `wifi` is in both — and that is correct,
    // not a collision: a venue can have Wi-Fi in the lobby and none in its
    // rooms. What matters is that the two are INDEPENDENT, which is the whole
    // reason one could not have absorbed the other.
    const libKeys = seeded.body.roomAmenities.map((a) => a.key);
    ok(libKeys.includes("wifi") && propertyAmenityKeys.includes("wifi"),
      "both lists have a `wifi` — the same word about two different things");
    await Venue.updateOne({ _id: venueId }, { $set: { "amenities.wifi": false } });
    const indep = await call(rt.listRoomAmenities, asOwner());
    ok(indep.body.roomAmenities.some((a) => a.key === "wifi" && a.isActive),
      "…turning the PROPERTY's Wi-Fi off leaves the room-amenity list untouched");
    const propAfter = await Venue.findById(venueId).select("amenities roomAmenities");
    ok(propAfter.amenities.wifi === false, "…and the property flag is genuinely off, so nothing wrote it back");
    // The structural difference, which is why one could not have absorbed the
    // other: a fixed set of boolean PATHS vs a DocumentArray the owner grows.
    ok(propertyAmenityKeys.length > 20 && Venue.schema.paths["amenities.wifi"].instance === "Boolean",
      `venue.amenities is ${propertyAmenityKeys.length} fixed booleans — an owner cannot add to it without a schema change`);
    ok(Venue.schema.path("roomAmenities").$isMongooseDocumentArray === true,
      "…while roomAmenities is a list of {key,label,isActive} an owner can extend at runtime");

    // ══ 2. A TYPE, AND ROOMS THAT INHERIT FROM IT ═══════════════════════════
    console.log("\n[two types, and rooms that belong to them]");
    const deluxeRes = await call(rt.addRoomType, asOwner({
      body: { name: "Deluxe", sleeps: 2, maxOccupancy: 3, defaultRate: 4500, amenities: ["ac", "wifi", "hot_water"] },
    }));
    ok(deluxeRes.code === 201, `Deluxe created (got ${deluxeRes.code})`);
    const deluxe = deluxeRes.body.roomType;

    for (const name of ["201", "202", "203"]) {
      await call(rooms.addRoom, asOwner({ body: { name, typeRef: String(deluxe._id) } }));
    }
    const r201 = await roomNamed("201");
    ok(r201.rate === 4500 && r201.capacity === 2, `201 inherits rate ${r201.rate} and capacity ${r201.capacity}`);
    ok(r201.fields.rate.source === "type" && r201.fields.rate.overridden === false, "…and reports the source as the type");
    ok(r201.amenityDetail.map((a) => a.label).join(", ") === "Air conditioning, Wi-Fi, Hot water",
      `…with amenities resolved to labels: ${r201.amenityDetail.map((a) => a.label).join(", ")}`);

    // ══ 3. THE OVERRIDE, AND THE TRAP ═══════════════════════════════════════
    console.log("\n[202 diverges deliberately — to a value the type ALSO holds]");
    // capacity 2 is exactly what Deluxe says. Value comparison cannot see this
    // as an override; only a recorded name can.
    const ov = await call(rooms.updateRoom, asOwner({ params: { roomId: String(r201._id) }, body: {} }));
    ok(ov.code === 200, "a no-op patch is harmless");
    const r202raw = await roomNamed("202");
    const setSame = await call(rooms.updateRoom, asOwner({ params: { roomId: String(r202raw._id) }, body: { capacity: 2 } }));
    ok(setSame.code === 200, `202 set to capacity 2 — the SAME number the type says (got ${setSame.code})`);
    ok(setSame.body.room.fields.capacity.overridden === true,
      "…and it is recorded as an override anyway, because the owner said it, not the type");
    ok(setSame.body.room.fields.capacity.value === 2 && setSame.body.room.fields.capacity.typeValue === 2,
      "…with the room's value and the type's both visible, and identical right now");

    console.log("\n[203 overrides the rate, and the screen can explain it]");
    const r203 = await roomNamed("203");
    const ovRate = await call(rooms.updateRoom, asOwner({ params: { roomId: String(r203._id) }, body: { rate: 9500 } }));
    ok(ovRate.body.room.fields.rate.overridden === true && ovRate.body.room.fields.rate.value === 9500, "203 rate is its own, at 9500");
    ok(ovRate.body.room.fields.rate.typeValue === 4500,
      `…and the type's 4500 comes back beside it, so the owner sees WHAT it diverged from, not just that it did`);

    // ══ 4. THE CASCADE ══════════════════════════════════════════════════════
    console.log("\n[editing the type cascades — except where a room said otherwise]");
    const edit = await call(rt.updateRoomType, asOwner({
      params: { typeId: String(deluxe._id) },
      body: { sleeps: 4, maxOccupancy: 5, defaultRate: 6000, amenities: ["ac", "wifi", "hot_water", "balcony"] },
    }));
    ok(edit.code === 200, `PATCH the type → 200 (got ${edit.code})`);
    ok(edit.body.cascadedTo === 3, `…reporting it reached ${edit.body.cascadedTo} rooms`);

    const a201 = await roomNamed("201");
    ok(a201.capacity === 4 && a201.rate === 6000, `201 followed the type (capacity ${a201.capacity}, rate ${a201.rate})`);
    ok(a201.amenityDetail.some((a) => a.key === "balcony"), "…including the new amenity");

    const a202 = await roomNamed("202");
    ok(a202.capacity === 2, `202 kept its own capacity 2 while the type moved to 4 (got ${a202.capacity})`);
    ok(a202.rate === 6000, `…but followed the type on rate, which it never overrode (got ${a202.rate})`);
    ok(a202.fields.capacity.typeValue === 4, "…and now shows the divergence plainly: room 2, type 4");

    const a203 = await roomNamed("203");
    ok(a203.rate === 9500 && a203.capacity === 4, `203 kept rate 9500 and followed capacity to 4 (got ${a203.rate}/${a203.capacity})`);

    console.log("\n[…which is the case value-comparison gets wrong]");
    ok(a202.capacity === 2 && a201.capacity === 4,
      "202 and 201 held the same 2 before the edit; only the recorded name told them apart");

    // ══ 5. PUTTING IT BACK ══════════════════════════════════════════════════
    console.log("\n[an override can be handed back to the type, and re-reads it NOW]");
    const reset = await call(rooms.updateRoom, asOwner({
      params: { roomId: String(a202._id) }, body: {}, // no value — just stop claiming it
    }));
    ok(reset.code === 200, "a patch with no values changes nothing");
    const reset2 = await call(rooms.updateRoom, asOwner({
      params: { roomId: String(a202._id) }, body: { clearOverrides: ["capacity"] },
    }));
    ok(reset2.body.room.capacity === 4, `202 back to the type's CURRENT 4 (got ${reset2.body.room.capacity}) — not the 2 it froze at`);
    ok(reset2.body.room.fields.capacity.source === "type" && reset2.body.room.overrides.length === 0, "…and no longer claims the field");

    // ══ 6. RETIRING AN AMENITY IN USE ═══════════════════════════════════════
    console.log("\n[an amenity in use is retired, never deleted]");
    const kill = await call(rt.deleteRoomAmenity, asOwner({ params: { key: "wifi" } }));
    ok(kill.code === 200 && kill.body.retired === true, `Wi-Fi is in use → retired, not deleted (got ${kill.code})`);
    ok((kill.body.usage.types || []).includes("Deluxe"), `…naming where it is used: ${(kill.body.usage.types || []).join(", ")}`);
    const stillThere = await roomNamed("201");
    const wifi = stillThere.amenityDetail.find((a) => a.key === "wifi");
    ok(wifi && wifi.label === "Wi-Fi" && wifi.retired === true,
      "…and rooms that have it KEEP it, resolved to its label and flagged as retired — not vanished, not a raw key");

    const unusedKill = await call(rt.deleteRoomAmenity, asOwner({ params: { key: "private_plunge_pool" } }));
    ok(unusedKill.code === 200 && unusedKill.body.deleted === true, "an amenity nobody uses is removed outright");

    console.log("\n[a retired key cannot be re-created, because things still point at it]");
    const revive = await call(rt.addRoomAmenity, asOwner({ body: { label: "Wi-Fi" } }));
    ok(revive.code === 409 && revive.body.code === "amenity_retired", `→ 409 amenity_retired (got ${revive.code}/${revive.body.code})`);
    ok(/Turn it back on/.test(revive.body.message || ""), `…telling the owner what to do instead: "${revive.body.message}"`);
    const back = await call(rt.updateRoomAmenity, asOwner({ params: { key: "wifi" }, body: { isActive: true } }));
    ok(back.code === 200 && back.body.amenity.isActive === true, "…and switching it back on works");

    console.log("\n[a retired amenity cannot be newly ASSIGNED while it is off]");
    await call(rt.updateRoomAmenity, asOwner({ params: { key: "tv" }, body: { isActive: false } }));
    const assignRetired = await call(rt.addRoomType, asOwner({ body: { name: "Retro", amenities: ["tv"] } }));
    ok(assignRetired.code === 400, `assigning a switched-off amenity → 400 (got ${assignRetired.code})`);
    ok(/has been removed from the amenity list/.test((assignRetired.body || {}).message || ""), "…in the owner's words, not a key");

    // ══ GROUPS, AND WHAT FLOATS ═════════════════════════════════════════════
    console.log("\n[amenities are grouped for the moment a type is being defined]");
    const listed = (await call(rt.listRoomAmenities, asOwner())).body.roomAmenities;
    const groupOf = Object.fromEntries(listed.map((a) => [a.key, a.group]));
    ok(groupOf.ac === "comfort", `AC is comfort (got ${groupOf.ac})`);
    ok(groupOf.hot_water === "bathroom" && groupOf.attached_bath === "bathroom", "hot water and the bathroom are bathroom");
    ok(groupOf.wifi === "entertainment" && groupOf.tv === "entertainment", "Wi-Fi and TV are entertainment");
    ok(groupOf.room_service === "extras", "room service is extras");

    console.log("\n[the groups come back in a fixed order, extras last]");
    const seq = [];
    for (const a of listed) if (!seq.includes(a.group)) seq.push(a.group);
    ok(JSON.stringify(seq) === JSON.stringify(["comfort", "bathroom", "entertainment", "extras"]),
      `order: ${seq.join(" → ")} — extras last, because it is the bucket for what did not fit`);

    console.log("\n[an amenity already on a type floats WITHIN its group]");
    // hot_water is on Deluxe from earlier in this suite; attached_bath is not.
    const bathroom = listed.filter((a) => a.group === "bathroom");
    ok(bathroom.length === 2, `two bathroom amenities (${bathroom.map((a) => a.label).join(", ")})`);
    ok(bathroom[0].key === "hot_water" && bathroom[0].usedBefore === true,
      "the one already in use comes first inside its group");
    ok(bathroom[1].usedBefore === false, "…and the unused one after it");
    ok(listed[0].group === "comfort",
      "…and it did NOT jump above the Comfort group — floating is within a group, not across the list");

    console.log("\n[a custom amenity lands where the owner puts it, never guessed from its label]");
    const jac = await call(rt.addRoomAmenity, asOwner({ body: { label: "Jacuzzi", group: "bathroom" } }));
    ok(jac.code === 201, "created with an explicit group");
    ok((jac.body.roomAmenities.find((a) => a.key === "jacuzzi") || {}).group === "bathroom", "…stored as bathroom");
    const noGroup = await call(rt.addRoomAmenity, asOwner({ body: { label: "Yoga mat" } }));
    ok((noGroup.body.roomAmenities.find((a) => a.key === "yoga_mat") || {}).group === "extras",
      "…and one with no group given goes to extras rather than being inferred from the word");
    const badGroup = await call(rt.addRoomAmenity, asOwner({ body: { label: "Hammock", group: "outdoors" } }));
    ok((badGroup.body.roomAmenities.find((a) => a.key === "hammock") || {}).group === "extras",
      "…a group that is not one of the four also falls to extras rather than creating a fifth");

    console.log("\n[an amenity stored BEFORE groups existed still resolves]");
    // Exactly the shape a pre-ROOMS-3 venue holds: no `group` at all.
    await Venue.updateOne(
      { _id: venueId, "roomAmenities.key": "ac" },
      { $unset: { "roomAmenities.$.group": "" } }
    );
    const afterUnset = (await call(rt.listRoomAmenities, asOwner())).body.roomAmenities;
    ok((afterUnset.find((a) => a.key === "ac") || {}).group === "comfort",
      "…recovered from the seed catalogue by key — no migration, and not a guess about the owner's text");
    const stored = await Venue.findById(venueId).select("roomAmenities");
    ok(!stored.roomAmenities.find((a) => a.key === "ac").group,
      "…and nothing was written back to the document to make that true");

    console.log("\n[relabelling is safe; the key never moves]");
    const relabel = await call(rt.updateRoomAmenity, asOwner({ params: { key: "hot_water" }, body: { label: "24h hot water" } }));
    ok(relabel.code === 200 && relabel.body.amenity.key === "hot_water", "the key is unchanged");
    const afterRelabel = await roomNamed("201");
    ok(afterRelabel.amenityDetail.find((a) => a.key === "hot_water").label === "24h hot water",
      "…and every room that references it picks up the new label with no migration");
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

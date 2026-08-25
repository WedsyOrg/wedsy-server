// ROOMS 4 / slice 1 — photos on the room type.
//
// Two claims to prove, and the second matters more than the first:
//
//   1. photos are ORDERED with exactly ONE cover, and the cover follows the
//      PHOTO rather than the position — reordering the gallery must not
//      silently change the one image a couple sees on the card
//   2. NOTHING about the couple-facing block changes for a venue that adds no
//      photos. The listing's "Total capacity" comes from Σ count ×
//      maxPeoplePerRoom, and VenueRepository sorts PUBLIC VENUE SEARCH by
//      accommodation.totalCapacity — an invented number reorders search
//      results, so this is re-proved rather than assumed to have survived
//      ROOMS 3.
//
// Run: node tests/venue-room-photos.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const rt = require("../controllers/venueRoomTypes");
const rooms = require("../controllers/venueRooms");
const { projectAccommodation, coverFirstUrls } = require("../utils/venueRoomTypes");

const TAG = `photos-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = [];
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

let venue;
const asOwner = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
});
const P = (n) => `https://cdn.example.invalid/${TAG}/${n}.jpg`;
const urlsOf = (type) => (type.photos || []).map((p) => p.url);
const coverOf = (type) => ((type.photos || []).find((p) => p.isCover) || {}).url || null;

/** The exact expressions wedsy-user/pages/venues/[slug].js:879-883 evaluates. */
function renderListing(acc) {
  const a = acc || {};
  const rts = Array.isArray(a.roomTypes) ? a.roomTypes : [];
  const accTotalRooms = rts.reduce((s, r) => s + (Number(r.count) || 0), 0) || (Number(a.rooms) || 0);
  const accTotalCap = Number(a.totalCapacity)
    || rts.reduce((s, r) => s + ((Number(r.count) || 0) * ((Number(r.maxPeoplePerRoom) || Number(r.occupancyPerRoom)) || 0)), 0);
  return {
    shows: a.available === true,
    accTotalRooms,
    accTotalCap,
    rows: rts.map((r) => ({
      name: r.name, count: r.count, occupancyPerRoom: r.occupancyPerRoom,
      maxPeoplePerRoom: r.maxPeoplePerRoom, pricePerNight: r.pricePerNight,
      isAC: r.isAC, description: r.description || "", photos: r.photos || [],
    })),
  };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      accommodation: { available: true },
    });
    created.push(venue._id);
    await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));

    // ══ 1. THE DERIVED BLOCK, BEFORE ANY OF THIS ════════════════════════════
    console.log("\n[a type with no photos and no new fields renders exactly as before]");
    const deluxe = (await call(rt.addRoomType, asOwner({
      body: { name: "Deluxe", sleeps: 2, maxOccupancy: 3, defaultRate: 4500 },
    }))).body.roomType;
    for (const n of ["101", "102", "103"]) {
      await call(rooms.addRoom, asOwner({ body: { name: n, typeRef: String(deluxe._id) } }));
    }
    const baseline = renderListing((await call(rt.listRoomTypes, asOwner())).body.accommodation);
    ok(baseline.shows === true, "the section still shows");
    ok(baseline.accTotalRooms === 3, `"3 rooms" (${baseline.accTotalRooms})`);
    ok(baseline.accTotalCap === 9, `"9 guests" (${baseline.accTotalCap}) — 3 × maxPeoplePerRoom 3`);
    ok(Array.isArray(baseline.rows[0].photos) && baseline.rows[0].photos.length === 0,
      "…and photos is an empty array, not undefined — the listing maps over it");
    const baselineJson = JSON.stringify(baseline);

    // ══ 2. PHOTOS ══════════════════════════════════════════════════════════
    console.log("\n[photos are appended in the order given]");
    const add1 = await call(rt.addTypePhotos, asOwner({
      params: { typeId: String(deluxe._id) }, body: { urls: [P("a"), P("b"), P("c")] },
    }));
    ok(add1.code === 201 && add1.body.added === 3, `3 added (got ${add1.body.added})`);
    let type = add1.body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok(urlsOf(type).join(",") === [P("a"), P("b"), P("c")].join(","), "…in the order sent");
    ok(coverOf(type) === P("a"), "…and the FIRST becomes the cover, because a type with photos must have one");

    console.log("\n[the same photo twice is skipped, not duplicated]");
    const dup = await call(rt.addTypePhotos, asOwner({
      params: { typeId: String(deluxe._id) }, body: { urls: [P("b"), P("d")] },
    }));
    ok(dup.body.added === 1 && dup.body.skipped === 1, `1 added, 1 skipped (${dup.body.added}/${dup.body.skipped})`);
    type = dup.body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok(urlsOf(type).length === 4, "four photos on the type");

    console.log("\n[the cover is EXPLICIT — reordering must not change it]");
    const setCover = await call(rt.setTypeCover, asOwner({
      params: { typeId: String(deluxe._id) }, body: { url: P("c") },
    }));
    ok(setCover.code === 200, `set cover → 200 (got ${setCover.code})`);
    type = setCover.body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok(coverOf(type) === P("c"), `cover is now c (${coverOf(type)})`);
    ok((type.photos || []).filter((p) => p.isCover).length === 1, "…and exactly one photo is the cover");

    const reordered = await call(rt.reorderTypePhotos, asOwner({
      params: { typeId: String(deluxe._id) }, body: { urls: [P("d"), P("a"), P("b"), P("c")] },
    }));
    ok(reordered.code === 200, `reorder → 200 (got ${reordered.code})`);
    type = reordered.body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok(urlsOf(type).join(",") === [P("d"), P("a"), P("b"), P("c")].join(","), "the order is exactly as sent");
    ok(coverOf(type) === P("c"),
      "…and the cover is STILL c, in fourth place — the cover follows the photo, not the position");

    console.log("\n[a reorder must name every photo exactly once]");
    const short = await call(rt.reorderTypePhotos, asOwner({
      params: { typeId: String(deluxe._id) }, body: { urls: [P("a")] },
    }));
    ok(short.code === 400 && short.body.code === "reorder_mismatch", `a partial list → 400 (got ${short.code})`);
    ok(/in full — got 1 of 4/.test(short.body.message), `…saying what is missing: "${short.body.message}"`);
    const dupOrder = await call(rt.reorderTypePhotos, asOwner({
      params: { typeId: String(deluxe._id) }, body: { urls: [P("a"), P("a"), P("b"), P("c")] },
    }));
    ok(dupOrder.code === 400 && /repeats/.test(dupOrder.body.message), "a repeated photo → 400");

    console.log("\n[removing the cover promotes another — never photos with no cover]");
    const removed = await call(rt.removeTypePhoto, asOwner({
      params: { typeId: String(deluxe._id) }, body: { url: P("c") },
    }));
    ok(removed.code === 200, `remove → 200 (got ${removed.code})`);
    type = removed.body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok(urlsOf(type).length === 3 && !urlsOf(type).includes(P("c")), "c is gone");
    ok(coverOf(type) === P("d"), `the first remaining photo became the cover (${coverOf(type)})`);
    ok((type.photos || []).filter((p) => p.isCover).length === 1, "…still exactly one cover");

    console.log("\n[removing them all leaves no cover to have]");
    for (const n of ["d", "a", "b"]) {
      await call(rt.removeTypePhoto, asOwner({ params: { typeId: String(deluxe._id) }, body: { url: P(n) } }));
    }
    const bare = (await call(rt.listRoomTypes, asOwner())).body.roomTypes.find((t) => String(t._id) === String(deluxe._id));
    ok((bare.photos || []).length === 0, "no photos left");
    ok(coverOf(bare) === null, "…and no cover, rather than a dangling flag");

    console.log("\n[a photo that is not on the type is a 404, not a silent no-op]");
    ok((await call(rt.removeTypePhoto, asOwner({ params: { typeId: String(deluxe._id) }, body: { url: P("zz") } }))).code === 404, "remove → 404");
    ok((await call(rt.setTypeCover, asOwner({ params: { typeId: String(deluxe._id) }, body: { url: P("zz") } }))).code === 404, "set cover → 404");

    // ══ 3. WHAT THE COUPLE GETS ════════════════════════════════════════════
    console.log("\n[the public block gets flat URLs, cover first]");
    await call(rt.addTypePhotos, asOwner({ params: { typeId: String(deluxe._id) }, body: { urls: [P("x"), P("y"), P("z")] } }));
    await call(rt.setTypeCover, asOwner({ params: { typeId: String(deluxe._id) }, body: { url: P("z") } }));
    const pub = (await call(rt.listRoomTypes, asOwner())).body.accommodation.roomTypes[0];
    ok(Array.isArray(pub.photos) && pub.photos.every((p) => typeof p === "string"),
      "the public shape is still a flat [String] — the couple-facing contract is unchanged");
    ok(pub.photos[0] === P("z"), `cover leads (${pub.photos[0].slice(-5)})`);
    ok(pub.photos.join(",") === [P("z"), P("x"), P("y")].join(","), "…then the owner's order");

    console.log("\n[…and NOTHING else about the block moved]");
    const after = renderListing((await call(rt.listRoomTypes, asOwner())).body.accommodation);
    ok(after.accTotalRooms === 3, `still "3 rooms" (${after.accTotalRooms})`);
    ok(after.accTotalCap === 9, `still "9 guests" (${after.accTotalCap}) — the sort key public search uses`);
    const strippedBefore = JSON.parse(baselineJson);
    const strippedAfter = JSON.parse(JSON.stringify(after));
    strippedBefore.rows.forEach((r) => { delete r.photos; });
    strippedAfter.rows.forEach((r) => { delete r.photos; });
    ok(JSON.stringify(strippedBefore) === JSON.stringify(strippedAfter),
      "every field except photos is byte-identical to before any of this");

    console.log("\n[totalCapacity is still Σ count × maxPeoplePerRoom — the search sort key]");
    const stored = await Venue.findById(venue._id).select("accommodation").lean();
    const recomputed = (stored.accommodation.roomTypes || [])
      .reduce((s, r) => s + (Number(r.count) || 0) * ((Number(r.maxPeoplePerRoom) || Number(r.occupancyPerRoom)) || 0), 0);
    ok(Number(stored.accommodation.totalCapacity) === recomputed,
      `stored ${stored.accommodation.totalCapacity} === the page's own fallback ${recomputed}`);

    console.log("\n[the photo cap is stated, not silently enforced]");
    const many = Array.from({ length: 12 }, (_, i) => P(`bulk${i}`));
    const over = await call(rt.addTypePhotos, asOwner({ params: { typeId: String(deluxe._id) }, body: { urls: many } }));
    ok(over.code === 400 && over.body.code === "photo_limit", `→ 400 photo_limit (got ${over.code})`);
    ok(/can hold 12 photos\. This one has 3\./.test(over.body.message), `…naming both numbers: "${over.body.message}"`);

    console.log("\n[coverFirstUrls tolerates the pre-ROOMS-4 [String] shape]");
    ok(coverFirstUrls(["p", "q"]).join(",") === "p,q", "a bare string list passes through");
    ok(coverFirstUrls([{ url: "p" }, { url: "q", isCover: true }]).join(",") === "q,p", "…and objects sort cover-first");

    console.log("\n[scope]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Mysore", state: "Karnataka" });
    created.push(other._id);
    const intruder = {
      ...asOwner({ params: { typeId: String(deluxe._id) }, body: { urls: [P("evil")] } }),
      venueOwner: { type: "venue_owner", venueId: other._id, role: "owner" },
    };
    ok((await call(rt.addTypePhotos, intruder)).code === 403, "another venue's owner → 403");
    const untouched = await Venue.findById(venue._id).select("roomTypes").lean();
    ok(!untouched.roomTypes[0].photos.some((p) => p.url.includes("evil")), "…and nothing was written");
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

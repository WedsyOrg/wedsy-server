// ROOMS 8 slice 1 — floors belong to a block, and the header counts STOREYS.
//
// ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
// Two separate claims, and the second is the one that was wrong:
//
//   1b/1c  A floor belongs to a BLOCK, not to the venue. Two blocks each have
//          their own Ground, and nothing an owner does to one may touch the
//          other. No existing venue has its floors reassigned — sparse storage,
//          uniform read, exactly as ROOMS 3 established.
//
//   1d     counts.floors summed BLOCK-FLOOR PAIRS, so a property with a Garden
//          Block and a Lake Wing that both run Ground and First reported four
//          storeys. It has two.
//
// ── WHY THE GARDEN/LAKE FIXTURE IS THE ONE THAT MATTERS ─────────────────────
// It is the only shape where the two arithmetics disagree. One block with two
// floors gives 2 either way, so a suite built on that would pass identically
// before and after the fix and prove nothing. Every count case here asserts the
// PAIR count as well, so the fixture is shown to be one that could have failed.
//
// ── AND WHY THE INVARIANT IS RE-PROVED, NOT ASSUMED ─────────────────────────
// There is no production block data at all — every real venue is the implicit
// single-block case, so these paths are unexercised by real data until an owner
// creates a block. The thing actually protecting production is that a venue
// with no blocks reads exactly as it did before. That is asserted AFTER the
// change, on the real stored shape of a venue like Crown Estate: rooms that
// carry no blockRef and no floorRef keys at all.
//
// Run: node tests/venue-floor-model.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const blocks = require("../controllers/venueRoomBlocks");
const { resolveLayout, distinctFloorCount } = require("../utils/venueRoomLayout");
const { setupState } = require("../utils/venueRoomSetup");

const TAG = `fm-${Date.now()}`;
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

/** The arithmetic this replaced, kept so every case can show the difference. */
const pairCount = (v) => (v.blocks || []).reduce((n, b) => n + (b.floors || []).length, 0);

/** Straight out of the collection — never the ORM object, never a response. */
const storedVenue = (id) => Venue.findById(id).lean();

let seq = 0;
const made = [];
async function fixture(blockSpecs = []) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({ name: slug, slug, city: "Bangalore", state: "Karnataka" });
  made.push(venue);
  for (const spec of blockSpecs) {
    const r = await call(blocks.addBlock, req(venue, { body: { name: spec.name, floors: spec.floors } }));
    if (r.code !== 201) throw new Error(`fixture block failed: ${JSON.stringify(r.body)}`);
  }
  return await Venue.findById(venue._id);
}

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  console.log(`DB: ${mongoose.connection.name}`);

  try {
    console.log("\n[1. THE PREMISE — Garden/Lake is a shape where the two arithmetics disagree]");
    {
      const v = {
        blocks: [
          { _id: "b1", name: "Garden Block", floors: [{ _id: "f1", name: "Ground" }, { _id: "f2", name: "First" }] },
          { _id: "b2", name: "Lake Wing", floors: [{ _id: "f3", name: "Ground" }, { _id: "f4", name: "First" }, { _id: "f5", name: "Second" }] },
        ],
        rooms: [],
      };
      eq(pairCount(v), 5, "🔴 the OLD arithmetic gives 5 — so this fixture could have failed");
      eq(distinctFloorCount(v), 3, "🔴 the new one gives 3 — Ground, First, Second");
      ok(pairCount(v) !== distinctFloorCount(v), "…and they genuinely differ here, which is the whole point");
      eq(resolveLayout(v).counts.floors, 3, "the layout legend reports 3");
      eq(setupState(v).counts.floors, 3, "🔴 and the wizard reports 3 — ONE implementation, not two");
    }

    console.log("\n[2. the arithmetic itself, case by case]");
    {
      const f = (...names) => ({ floors: names.map((n, i) => ({ _id: `f${Math.random()}`, name: n })) });
      const cases = [
        { label: "no blocks at all", v: { blocks: [] }, pairs: 0, distinct: 0 },
        { label: "one block, no floors", v: { blocks: [{ name: "A", floors: [] }] }, pairs: 0, distinct: 0 },
        { label: "one block, Ground + First", v: { blocks: [{ name: "A", ...f("Ground", "First") }] }, pairs: 2, distinct: 2 },
        { label: "two blocks, identical floors", v: { blocks: [{ name: "A", ...f("Ground", "First") }, { name: "B", ...f("Ground", "First") }] }, pairs: 4, distinct: 2 },
        { label: "two blocks, disjoint floors", v: { blocks: [{ name: "A", ...f("Ground") }, { name: "B", ...f("Terrace") }] }, pairs: 2, distinct: 2 },
        { label: "case and padding are one storey", v: { blocks: [{ name: "A", ...f("Ground") }, { name: "B", ...f("  ground ") }] }, pairs: 2, distinct: 1 },
      ];
      for (const c of cases) {
        eq(pairCount(c.v), c.pairs, `${c.label} — old arithmetic`);
        eq(distinctFloorCount(c.v), c.distinct, `${c.label} — storeys`);
      }
    }

    console.log("\n[3. 🔴 THE LIMIT THIS COUNT LIVES WITH — asserted, not left to a comment]");
    {
      // Distinct-name counting is only honest while floor names are a
      // controlled vocabulary. Two spellings of one storey count as two. This
      // is what makes the floor SUGGESTION PICKER load-bearing rather than
      // cosmetic: it is what keeps two blocks agreeing on the word. Asserted
      // here so anyone who removes the picker sees the consequence in a test
      // rather than discovering it in a header.
      const v = {
        blocks: [
          { name: "Garden", floors: [{ name: "First" }] },
          { name: "Lake", floors: [{ name: "1st" }] },
        ],
      };
      eq(distinctFloorCount(v), 2,
        "🔴 'First' and '1st' count as TWO storeys — the count depends on the picker keeping names uniform");
    }

    {
      // ── ROOMS 9: THE COST OF CHANGING THE VOCABULARY, STATED ─────────────
      // The floor picker offered "1", "2", "3" and now offers "First",
      // "Second", "Third". Nothing was migrated and nothing is ever written
      // back — a venue that stored "1" keeps "1" and renders it as typed.
      //
      // So a property built before this change and extended after it can hold
      // "1" in one block and "First" in another, and this function will call
      // that two storeys. That is the SAME property of distinct-name counting
      // the assertion above protects, reached by a different route, and it is
      // an accepted cost rather than an oversight: rewriting an owner's stored
      // floor names to tidy the arithmetic would be the worse trade.
      //
      // Asserted so the cost is visible in a test rather than discovered in a
      // header, and so anyone tempted to "fix" it by migrating sees what they
      // would be changing.
      const v = {
        blocks: [
          { name: "Old Wing", floors: [{ name: "1" }] },
          { name: "New Wing", floors: [{ name: "First" }] },
        ],
      };
      eq(distinctFloorCount(v), 2,
        "🔴 a venue that stored '1' before the ordinals and 'First' after counts TWO — nothing is rewritten to hide it");
    }

    console.log("\n[4. 1b — a floor belongs to a BLOCK, proved on the stored document]");
    {
      const venue = await fixture([
        { name: "Garden Block", floors: ["Ground", "First"] },
        { name: "Lake Wing", floors: ["Ground", "First"] },
      ]);
      let stored = await storedVenue(venue._id);
      eq(stored.blocks.length, 2, "two blocks stored");
      eq(distinctFloorCount(stored), 2, "🔴 four floor rows, two storeys");
      eq(pairCount(stored), 4, "🔴 …and the old arithmetic would have said four");

      const gardenGround = stored.blocks[0].floors[0];
      const lakeGround = stored.blocks[1].floors[0];
      ok(String(gardenGround._id) !== String(lakeGround._id),
        "🔴 the two Grounds are SEPARATE rows with separate ids — not one venue-level floor shared");

      // Add a floor to Lake Wing only.
      const add = await call(blocks.addFloor, req(venue, {
        params: { blockId: String(stored.blocks[1]._id) }, body: { name: "Second" },
      }));
      eq(add.code, 201, "added Second to Lake Wing");
      stored = await storedVenue(venue._id);
      eq(stored.blocks[0].floors.length, 2, "🔴 Garden Block is UNTOUCHED — still two floors");
      eq(stored.blocks[1].floors.length, 3, "…Lake Wing has three");
      eq(distinctFloorCount(stored), 3, "🔴 and the property is now three storeys");
      eq(stored.blocks[0].floors.map((x) => x.name).join(","), "Ground,First", "Garden's floor NAMES are unchanged");

      // Rename Lake Wing's Ground. Garden's Ground must not move.
      const ren = await call(blocks.updateFloor, req(venue, {
        params: { blockId: String(stored.blocks[1]._id), floorId: String(stored.blocks[1].floors[0]._id) },
        body: { name: "Lower Ground" },
      }));
      eq(ren.code, 200, "renamed Lake Wing's Ground");
      stored = await storedVenue(venue._id);
      eq(stored.blocks[0].floors[0].name, "Ground", "🔴 GARDEN'S GROUND IS STILL CALLED GROUND");
      eq(stored.blocks[1].floors[0].name, "Lower Ground", "…only Lake Wing's changed");
      eq(distinctFloorCount(stored), 4, "…and the storey count follows: Ground, First, Second, Lower Ground");

      // Two blocks may hold DIFFERENT COUNTS of floors — 1b's second sentence.
      ok(stored.blocks[0].floors.length !== stored.blocks[1].floors.length,
        "🔴 the two blocks hold different numbers of floors, and both are valid");
    }

    console.log("\n[5. 1c — an existing venue reads EXACTLY as it did (ROOMS 3), re-proved AFTER the change]");
    {
      // The real stored shape of a venue like Crown Estate: rooms carrying no
      // blockRef and no floorRef KEYS AT ALL, and no blocks field.
      const crownLike = {
        rooms: [
          { _id: "r1", name: "Rose", type: "standard", capacity: 2, notes: "", isActive: true },
          { _id: "r2", name: "Lily", type: "standard", capacity: 2, notes: "", isActive: true },
        ],
      };
      ok(!("blocks" in crownLike), "the fixture really has NO blocks key, like the stored document");
      ok(!("blockRef" in crownLike.rooms[0]), "…and its rooms really carry no blockRef key");

      const absent = resolveLayout(crownLike);
      const empty = resolveLayout({ blocks: [], rooms: crownLike.rooms });
      const shape = (r) => JSON.stringify({
        blocks: r.blocks.length,
        implicit: r.blocks[0].isImplicit,
        unplaced: r.blocks[0].isUnplaced,
        floors: r.blocks[0].floors.length,
        roomsIn: r.blocks[0].floors[0].rooms.length,
        counts: r.counts,
      });
      eq(shape(absent), shape(empty),
        "🔴 field ABSENT and blocks: [] still resolve BYTE-IDENTICALLY — both exist in the wild");
      eq(absent.blocks.length, 1, "one implicit block");
      eq(absent.blocks[0].isImplicit, true, "…marked implicit");
      eq(absent.blocks[0].isUnplaced, false, "🔴 NOT unplaced — no blocks means the whole property, not two problems");
      eq(absent.blocks[0].floors[0].rooms.length, 2, "…holding both rooms");
      eq(absent.counts.floors, 0, "🔴 zero storeys, because the owner never named one");
      eq(absent.counts.blocks, 0, "…and zero blocks");
      ok(!("blockRef" in crownLike.rooms[0]), "🔴 AND NOTHING WAS WRITTEN TO THE ROOM — no floor was inferred for it");
    }

    console.log("\n[6. the two consumers cannot drift — the reason this is one helper]");
    {
      const venue = await fixture([
        { name: "Garden Block", floors: ["Ground", "First"] },
        { name: "Lake Wing", floors: ["Ground", "First", "Second"] },
      ]);
      const stored = await storedVenue(venue._id);
      const layoutN = resolveLayout(stored).counts.floors;
      const setupN = setupState(stored).counts.floors;
      const apiN = (await call(blocks.getLayout, req(venue))).body.counts.floors;
      // getSetup nests its state under `setup` — read the shape it actually
      // returns, not the one the sibling endpoint returns.
      const setupApiN = (await call(blocks.getSetup, req(venue))).body.setup.counts.floors;
      eq(layoutN, 3, "resolveLayout says 3");
      eq(setupN, 3, "setupState says 3");
      eq(apiN, 3, "🔴 GET /room-blocks says 3");
      eq(setupApiN, 3, "🔴 GET /room-setup says 3");
      eq(pairCount(stored), 5, "🔴 …where the old arithmetic said 5 on all four");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try { for (const v of made) await Venue.deleteMany({ _id: v._id }); } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();

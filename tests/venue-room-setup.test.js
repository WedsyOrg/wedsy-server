// ROOMS 3 / slice 4 — the first-run wizard.
//
// The claim under test: the wizard is resumable BY CONSTRUCTION, because the
// step is a function of what the owner has actually built rather than a
// progress counter kept beside it. So the suite never "resumes" by restoring
// state — it re-reads the venue from the database, which is what a browser
// reopened next week does.
//
// It also pins the two things that genuinely cannot be derived, since those are
// the only places this design can go wrong:
//   · "one building, one floor" leaves NO blocks, byte-identical to never
//     having done the step — without recording it the owner is sent back forever
//   · "never appears again once built" has to survive deleting every room
//
// Run: node tests/venue-room-setup.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const blocks = require("../controllers/venueRoomBlocks");
const rooms = require("../controllers/venueRooms");
const rt = require("../controllers/venueRoomTypes");
const { deriveStep } = require("../utils/venueRoomSetup");

const TAG = `setup-${Date.now()}`;
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
/** Re-read the wizard the way a reopened browser does: from the database. */
const step = async () => (await call(blocks.getSetup, asOwner())).body.setup;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ 1. THE ORDER, AND WHY ═══════════════════════════════════════════════
    console.log("\n[a brand new venue starts at the shape]");
    venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.push(venue._id);
    let s = await step();
    ok(s.step === "shape", `step is "${s.step}"`);
    ok(s.done === false && s.completed.length === 0, "nothing completed yet");
    ok(JSON.stringify(s.steps) === JSON.stringify(["shape", "types", "rooms"]),
      "…and the order is shape → types → rooms: a room needs somewhere to be and something to be");

    console.log("\n[building the shape advances it — no progress counter involved]");
    await call(blocks.addBlock, asOwner({ body: { name: "Garden Block", floors: ["Ground", "First"] } }));
    s = await step();
    ok(s.step === "types", `step is now "${s.step}"`);
    ok(s.completed.join(",") === "shape", "shape is completed because blocks EXIST, not because a flag was set");

    console.log("\n[…and it survives a full reload, because it was never held in memory]");
    const reread = deriveStep(await Venue.findById(venue._id));
    ok(reread.step === "types", "re-derived straight from the document: still types");

    console.log("\n[adding a type advances to rooms]");
    await call(rt.addRoomAmenity, asOwner({ body: { seed: true } }));
    const deluxe = (await call(rt.addRoomType, asOwner({
      body: { name: "Deluxe", sleeps: 2, defaultRate: 4500, amenities: ["ac", "wifi"] },
    }))).body.roomType;
    s = await step();
    ok(s.step === "rooms" && s.completed.join(",") === "shape,types", `step "${s.step}", completed ${s.completed.join(",")}`);
    ok(s.counts.types === 1 && s.counts.blocks === 1 && s.counts.floors === 2,
      `counts follow the data: ${s.counts.blocks} block, ${s.counts.floors} floors, ${s.counts.types} type`);

    // ══ 2. BULK IS THE DEFAULT PATH, AND IT PLACES ══════════════════════════
    console.log("\n[step three is ONE action: block, floor, type and range together]");
    const v1 = await Venue.findById(venue._id);
    const block = v1.blocks[0];
    const ground = block.floors.find((f) => f.name === "Ground");

    const preview = await call(rooms.bulkCreateRooms, asOwner({
      body: {
        blockRef: String(block._id), floorRef: String(ground._id),
        typeRef: String(deluxe._id), from: 101, to: 112, preview: true,
      },
    }));
    ok(preview.code === 200, `preview → 200 (got ${preview.code}${preview.code !== 200 ? ": " + JSON.stringify(preview.body) : ""})`);
    ok(preview.code === 200 && (preview.body.willCreate || []).length === 12, `preview says 12 (got ${(preview.body.willCreate || []).length})`);
    ok(String(preview.body.placement.blockRef) === String(block._id),
      "…and the preview states WHERE, not just what — preview and apply are one computation");

    const made = await call(rooms.bulkCreateRooms, asOwner({
      body: {
        blockRef: String(block._id), floorRef: String(ground._id),
        typeRef: String(deluxe._id), from: 101, to: 112,
      },
    }));
    ok(made.code === 201 && made.body.createdCount === 12, `created ${made.body.createdCount} rooms`);

    const layout = (await call(blocks.getLayout, asOwner())).body;
    const groundFloor = layout.layout[0].floors.find((f) => f.name === "Ground");
    ok(groundFloor.rooms.length === 12, `all 12 landed on Ground in one action (${groundFloor.rooms.length})`);
    ok(groundFloor.rooms.every((r) => r.typeName === "Deluxe"), "…all typed Deluxe");
    ok(groundFloor.rooms.every((r) => r.rate === 4500), "…and inheriting the type's rate");
    ok(layout.counts.unplaced === 0, "…and none unplaced — the placement happened at creation, not afterwards");

    console.log("\n[a bad placement fails on NOTHING, not on half a floor]");
    const before = (await Venue.findById(venue._id)).rooms.length;
    const wrong = await call(rooms.bulkCreateRooms, asOwner({
      body: { blockRef: String(block._id), floorRef: String(new mongoose.Types.ObjectId()), from: 201, to: 210 },
    }));
    ok(wrong.code === 400, `an unknown floor → 400 (got ${wrong.code})`);
    ok((await Venue.findById(venue._id)).rooms.length === before, "…and not one room was created");

    // ══ 3. DONE, AND STAYING DONE ═══════════════════════════════════════════
    // ── THESE ASSERTIONS CHANGED IN ROOMS 8, DELIBERATELY ───────────────────
    // They read `rooms exist → step "done"`, which is the semantics that let
    // the wizard's step advance itself. `done` and `finished` are now two
    // questions:
    //
    //   done      should first-run setup be OFFERED?   — a suppression
    //   finished  has the owner SAID they are done?    — completedAt, only ever
    //
    // The suppression guarantee this section exists for is unchanged and still
    // asserted below. What is no longer claimed is that one room existing means
    // the owner has finished adding rooms.
    console.log("\n[rooms exist, so the wizard is not OFFERED — but the step is not over]");
    s = await step();
    ok(s.done === true, `not offered unprompted (done=${s.done})`);
    ok(s.finished === false, `🔴 …but NOT finished — the owner has not said so (finished=${s.finished})`);
    ok(s.step === "rooms", `🔴 …and the resume point is still the rooms step, not "done" (got "${s.step}")`);
    ok(s.reason === "rooms_exist", `…because rooms exist (${s.reason})`);
    ok(!s.completed.includes("rooms"),
      "🔴 the rooms step is NOT in `completed` — completion of it is not derivable");

    console.log("\n[and it does not come back when every room is deleted]");
    await call(blocks.completeSetup, asOwner());
    const stripped = await Venue.findById(venue._id);
    stripped.rooms = [];
    await stripped.save();
    s = await step();
    ok(s.step === "done" && s.done === true && s.finished === true, "still done with zero rooms");
    ok(s.reason === "completed", `…because it was completed (${s.reason}) — being walked through first-run setup on a property you have run for a year is worse than an empty list`);

    // ══ 3b. NO STEP ADVANCES ITSELF — THE BUG THAT SHIPPED TWICE ════════════
    //
    // ROOMS 3 fixed it for blocks: adding one block completed the shape step
    // and a second could not be added. The fix gave the wizard its own `viewing`
    // state — and then kept ONE server override, `setup.done ? "done" : viewing`,
    // which made the first ROOM end the rooms step the same way.
    //
    // ── WHICH HALF OF THIS THE SERVER OWNS ─────────────────────────────────
    // The step ADVANCING as data accumulates is correct and intended here: it
    // is a resume point, and an owner who built their blocks last week should
    // come back to types, not to a step they finished. That is why this suite
    // asserts the step moves to "types" once a block exists.
    //
    // "No step advances itself" is a CLIENT property — it is about the step on
    // screen under an owner who is mid-task, and it is held by the wizard's own
    // `viewing` state, which no server field may write. It is driven in the
    // browser, not assertable from here.
    //
    // What the SERVER owes, and what this asserts, is the other half: the rooms
    // step is never reported complete from data. That is the field the wizard's
    // one remaining override read, and it is why the bug came back.
    console.log("\n[🔴 the rooms step is never completed by data — only by the owner]");
    {
      const v = await Venue.create({ name: `${TAG} Self`, slug: `${TAG}-self`, city: "Coorg", state: "Karnataka" });
      created.push(v._id);
      const at = async () => (await call(blocks.getSetup, { params: { slug: v.slug }, query: {}, body: {}, venueOwner: { venueId: String(v._id) } })).body.setup;

      ok((await at()).step === "shape", "starts at shape");

      // ── SHAPE: two blocks, and the first must not end the step ────────────
      const mk = (name) => call(blocks.addBlock, { params: { slug: v.slug }, query: {}, body: { name, floors: ["Ground"] }, venueOwner: { venueId: String(v._id) } });
      await mk("Garden Block");
      let s2 = await at();
      // Intended: a returning owner resumes past a step they have satisfied.
      // ROOMS 3's bug was the WIZARD rendering off this live, not this value.
      ok(s2.step === "types", `after the first block the RESUME point moves to types (got "${s2.step}")`);
      ok(s2.completed.includes("shape") && !s2.completed.includes("rooms"),
        "…shape is completed by data; rooms is not, and never is");
      await mk("Lake Wing");
      ok((await Venue.findById(v._id)).blocks.length === 2, "…and a second block can still be added");

      // ── TYPES: same shape of question ─────────────────────────────────────
      const fresh = await Venue.findById(v._id);
      fresh.roomTypes.push({ name: "Standard", sleeps: 2 });
      await fresh.save();
      s2 = await at();
      ok(s2.step === "rooms", "with blocks and a type the resume point moves to rooms");

      // ── ROOMS: the recurrence. One room must not end the step ─────────────
      const withRoom = await Venue.findById(v._id);
      withRoom.rooms.push({ name: "101", isActive: true });
      await withRoom.save();
      s2 = await at();
      ok(s2.step === "rooms", `🔴 after the FIRST room the resume point is STILL rooms (got "${s2.step}") — the recurrence`);
      ok(s2.finished === false, "🔴 …and the owner has not finished, because they have not said so");

      // Ten more, the second batch — the case the ROOMS 3 drive never ran.
      const more = await Venue.findById(v._id);
      for (let i = 2; i <= 11; i += 1) more.rooms.push({ name: `1${String(i).padStart(2, "0")}`, isActive: true });
      await more.save();
      s2 = await at();
      ok(s2.step === "rooms", "🔴 eleven rooms in, still the rooms step — nothing has ended it");
      ok(s2.finished === false, "…still not finished");

      // ── AND ONLY THE EXPLICIT ACTION ENDS IT ──────────────────────────────
      await call(blocks.completeSetup, { params: { slug: v.slug }, query: {}, body: {}, venueOwner: { venueId: String(v._id) } });
      s2 = await at();
      ok(s2.step === "done" && s2.finished === true,
        "🔴 the owner pressing Finish is the ONLY thing that ended it");
      ok((await Venue.findById(v._id)).roomSetup.completedAt instanceof Date,
        "…and it is stored as completedAt, not inferred from the rooms");
    }

    // ══ 4. THE SKIP — THE OTHER THING THAT CANNOT BE DERIVED ════════════════
    console.log("\n['one building, one floor' — the case that breaks a derived step]");
    const simple = await Venue.create({ name: `${TAG} Cottages`, slug: `${TAG}-c`, city: "Coorg", state: "Karnataka" });
    created.push(simple._id);
    venue = simple;
    ok((await step()).step === "shape", "starts at shape");

    const skipped = await call(blocks.skipShape, asOwner());
    ok(skipped.code === 200, `skip → 200 (got ${skipped.code})`);
    s = await step();
    ok(s.step === "types", `advances to "${s.step}" with NO blocks created`);
    ok(s.counts.blocks === 0, "…and there are genuinely zero blocks — nothing was invented to fill the step");
    ok(s.shapeSkipped === true, "…the skip is recorded, because it is indistinguishable from not having done it");

    console.log("\n[…and the skip survives a reload, which is the whole point]");
    ok(deriveStep(await Venue.findById(simple._id)).step === "types",
      "re-derived from the document: still types, not back to shape");

    console.log("\n[skipping when blocks already exist is refused, not silently flagged]");
    venue = await Venue.findById(created[0]);
    const already = await call(blocks.skipShape, asOwner());
    ok(already.code === 409 && already.body.code === "shape_exists", `→ 409 (got ${already.code})`);
    ok(/already has blocks/.test(already.body.message), `…saying why: "${already.body.message}"`);

    // ══ 5. DISMISSAL IS NOT COMPLETION ══════════════════════════════════════
    console.log("\n[\"not now\" stops it interrupting without pretending it is done]");
    venue = simple;
    const dis = await call(blocks.dismissSetup, asOwner());
    ok(dis.code === 200 && Boolean(dis.body.setup.dismissedAt), "dismissedAt is set");
    s = await step();
    ok(s.step === "types" && s.done === false,
      "…and the STEP is unchanged — dismissing is a courtesy, not progress, so the empty page can still offer it");

    console.log("\n[scope]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Mysore", state: "Karnataka" });
    created.push(other._id);
    const intruder = { ...asOwner(), venueOwner: { type: "venue_owner", venueId: other._id, role: "owner" } };
    for (const [name, fn] of [["GET room-setup", blocks.getSetup], ["POST skip-shape", blocks.skipShape], ["POST complete", blocks.completeSetup]]) {
      ok((await call(fn, intruder)).code === 403, `${name} → 403`);
    }
    ok((await Venue.findById(simple._id)).roomSetup.completedAt == null, "…and nothing was completed on our behalf");
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

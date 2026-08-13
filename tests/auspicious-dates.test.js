// Auspicious (muhurat) dates — the platform's shared wedding-date calendar.
// Run: node tests/auspicious-dates.test.js
//
// The four things that must hold, because every other surface is going to
// trust them:
//   · RESOLUTION — national (region=null) OR matching-region, additive, never
//     an override chain. A regional row must not hide a national one, and a
//     venue in another region must not see it.
//   · ONE QUERY — a 120-day window is one round trip, not 120. Asserted by
//     counting driver calls, not by reading the code.
//   · CAPABILITY — auspicious_dates_manage gates every write; an admin with
//     the neighbouring venues_* capabilities is refused.
//   · IDEMPOTENCE — the same date submitted twice is one row. A year is
//     entered by a human in batches; re-submitting a month is normal, not an
//     error and not a duplicate.
require("dotenv").config();
const mongoose = require("mongoose");

const AuspiciousDate = require("../models/AuspiciousDate");
const Venue = require("../models/Venue");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const ctl = require("../controllers/auspiciousDates");
const { getVenueAuspiciousDates } = require("../controllers/venueAuspiciousDates");
const { requirePermission } = require("../middlewares/requirePermission");
const aus = require("../utils/auspiciousDates");
const { validatePermissions } = require("../utils/rbacPermissions");

const TAG = `aus-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const adminReq = (adminId, extra = {}) => ({ params: extra.params || {}, query: extra.query || {}, body: extra.body || {}, auth: { user_id: adminId } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() }, venueMember: null });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };

// Runs the real gate and reports whether next() was reached.
const gate = async (perm, adminId) => {
  const r = adminReq(adminId);
  const res = mockRes();
  let ran = false;
  await requirePermission(perm)(r, res, () => { ran = true; });
  return { ran, code: res.code };
};

const created = { admins: [], roles: [], depts: [], venues: [] };
// Everything this suite writes lands in one year far outside real data.
const YEAR = 2091;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await AuspiciousDate.deleteMany({ year: YEAR });
    // The unique {date, region} index has to exist for the idempotency and
    // conflict assertions to mean anything on a fresh collection.
    await AuspiciousDate.syncIndexes();

    // ── vocabulary ──────────────────────────────────────────────────────────
    console.log("\n[permission vocabulary]");
    ok(validatePermissions(["auspicious_dates_manage:edit:all"]).valid, "auspicious_dates_manage is a known resource");
    ok(!validatePermissions(["auspicious_dates:edit:all"]).valid, "…and a near-miss resource name is still rejected");

    // ── fixtures ────────────────────────────────────────────────────────────
    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const managerRole = await Role.create({ name: `${TAG}-cal`, departmentId: dept._id, permissions: ["auspicious_dates_manage:*:all"] });
    // Holds the neighbouring venue capabilities but NOT the calendar one — the
    // exact shape that must be refused.
    const venueOnlyRole = await Role.create({ name: `${TAG}-venueonly`, departmentId: dept._id, permissions: ["venues:view:all", "venues_enrich:edit:all", "venues_onboard:edit:all"] });
    created.roles.push(managerRole._id, venueOnlyRole._id);
    const manager = await Admin.create({ name: `${TAG}-m`, email: `${TAG}-m@w.in`, phone: `${TAG}1`, password: "x", roleIds: [managerRole._id], departmentId: dept._id });
    const venueOnly = await Admin.create({ name: `${TAG}-v`, email: `${TAG}-v@w.in`, phone: `${TAG}2`, password: "x", roleIds: [venueOnlyRole._id], departmentId: dept._id });
    created.admins.push(manager._id, venueOnly._id);

    // ── capability denial ───────────────────────────────────────────────────
    console.log("\n[capability]");
    ok((await gate("auspicious_dates_manage:view:all", manager._id)).ran, "the calendar role passes view");
    ok((await gate("auspicious_dates_manage:create:all", manager._id)).ran, "…create");
    ok((await gate("auspicious_dates_manage:delete:all", manager._id)).ran, "…delete");
    const denied = await gate("auspicious_dates_manage:create:all", venueOnly._id);
    ok(!denied.ran && denied.code === 403, "an admin with venues_* but not the calendar capability is REFUSED (403)");
    const deniedView = await gate("auspicious_dates_manage:view:all", venueOnly._id);
    ok(!deniedView.ran, "…including the read");

    // ── bulk create + idempotency ───────────────────────────────────────────
    console.log("\n[bulk create + idempotency]");
    const nov = [`${YEAR}-11-20`, `${YEAR}-11-21`, `${YEAR}-11-25`, `${YEAR}-11-26`];
    const first = await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: nov } }));
    ok(first.code === 201, "bulk create → 201");
    ok(first.body.created === 4 && first.body.updated === 0, `4 created, 0 updated (got ${first.body.created}/${first.body.updated})`);
    ok((await AuspiciousDate.countDocuments({ year: YEAR })) === 4, "…4 rows exist");

    const again = await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: nov } }));
    ok(again.code === 201, "re-submitting the same month is not an error");
    ok(again.body.created === 0 && again.body.updated === 4, `THE IDEMPOTENCY: 0 created, 4 updated (got ${again.body.created}/${again.body.updated})`);
    ok((await AuspiciousDate.countDocuments({ year: YEAR })) === 4, "…still 4 rows, not 8");

    // Same date twice INSIDE one batch collapses rather than racing the index.
    const dupeBatch = await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-12-01`, `${YEAR}-12-01`], tier: "major" } }));
    ok(dupeBatch.code === 201, "a batch containing the same date twice → 201");
    ok((await AuspiciousDate.countDocuments({ year: YEAR, month: 12, day: 1 })) === 1, "…and writes ONE row");

    // The denormalised columns must match the key, or the month grid lies.
    const nov25 = await AuspiciousDate.findOne({ year: YEAR, month: 11, day: 25 }).lean();
    ok(Boolean(nov25), "y/m/d are denormalised off the day key");
    ok(nov25.date.toISOString().slice(0, 10) === `${YEAR}-11-25`, "…and the stored date is midnight UTC of that calendar day");
    ok(nov25.region === null && nov25.tier === null, "…defaults: national, no tier");

    // ── validation ──────────────────────────────────────────────────────────
    console.log("\n[validation]");
    ok((await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [] } }))).code === 400, "empty dates → 400");
    const bad = await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-02-31`] } }));
    ok(bad.code === 400 && Array.isArray(bad.body.invalid), "an impossible calendar date (Feb 31) → 400, not silently rolled to Mar 3");
    ok((await AuspiciousDate.countDocuments({ year: YEAR, month: 3 })) === 0, "…and nothing was written for March");
    ok((await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-11-20`], tier: "auspicious-ish" } }))).code === 400, "an unknown tier → 400");

    // ── national vs regional resolution ─────────────────────────────────────
    console.log("\n[resolution: national vs regional]");
    // A Karnataka-only date and a Tamil Nadu-only date, plus the national ones.
    await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-11-22`], region: "Karnataka", tier: "moderate" } }));
    await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-11-23`], region: "Tamil Nadu" } }));

    ok(await aus.isAuspicious(`${YEAR}-11-25`), "a national date is auspicious with no region asked");
    ok(await aus.isAuspicious(`${YEAR}-11-25`, "Karnataka"), "…and for a Karnataka venue");
    ok(await aus.isAuspicious(`${YEAR}-11-25`, "Tamil Nadu"), "…and for a Tamil Nadu venue");
    ok(await aus.isAuspicious(`${YEAR}-11-22`, "Karnataka"), "a Karnataka-only date is auspicious in Karnataka");
    ok(!(await aus.isAuspicious(`${YEAR}-11-22`, "Tamil Nadu")), "…and NOT in Tamil Nadu");
    ok(!(await aus.isAuspicious(`${YEAR}-11-22`)), "…and not nationally");
    ok(!(await aus.isAuspicious(`${YEAR}-11-24`, "Karnataka")), "a date nobody entered is not auspicious anywhere");
    ok(await aus.isAuspicious(`${YEAR}-11-22`, ["Tamil Nadu", "Karnataka"]), "a multi-region ask matches on any of them");

    // A regional row must not SHADOW the national one on the same date.
    await call(ctl.bulkCreateAuspiciousDates, adminReq(manager._id, { body: { dates: [`${YEAR}-11-25`], region: "Karnataka", tier: "major" } }));
    ok(await aus.isAuspicious(`${YEAR}-11-25`, "Tamil Nadu"), "adding a Karnataka row on a national date leaves Tamil Nadu unaffected");
    const both = await aus.lookupRange({ from: `${YEAR}-11-25`, to: `${YEAR}-11-25`, region: "Karnataka" });
    const merged = both.get(`${YEAR}-11-25`);
    ok(merged && merged.national === true && merged.regions.includes("Karnataka"), "…and the two rows merge into one answer");
    ok(merged.tier === "major", "…taking the STRONGEST tier claim, not the first row");

    // ── bulk range: correctness + ONE query ─────────────────────────────────
    console.log("\n[bulk range lookup]");
    const range = await aus.lookupRange({ from: `${YEAR}-11-01`, to: `${YEAR}-11-30`, region: "Karnataka" });
    const keys = [...range.keys()].sort();
    ok(
      JSON.stringify(keys) === JSON.stringify([`${YEAR}-11-20`, `${YEAR}-11-21`, `${YEAR}-11-22`, `${YEAR}-11-25`, `${YEAR}-11-26`]),
      `November for Karnataka = the 4 national + the Karnataka one (got ${keys.length}: ${keys.join(",")})`
    );
    const tnRange = await aus.lookupRange({ from: `${YEAR}-11-01`, to: `${YEAR}-11-30`, region: "Tamil Nadu" });
    ok([...tnRange.keys()].includes(`${YEAR}-11-23`) && !([...tnRange.keys()].includes(`${YEAR}-11-22`)), "…and Tamil Nadu gets its own date, not Karnataka's");
    const nationalOnly = await aus.lookupRange({ from: `${YEAR}-11-01`, to: `${YEAR}-11-30` });
    ok([...nationalOnly.keys()].length === 4, "no region asked = national rows only");

    // Boundaries are INCLUSIVE at both ends, or a month grid loses its edges.
    const edge = await aus.lookupRange({ from: `${YEAR}-11-20`, to: `${YEAR}-11-26`, region: "Karnataka" });
    ok(edge.has(`${YEAR}-11-20`) && edge.has(`${YEAR}-11-26`), "the range includes both endpoints");
    ok((await aus.lookupRange({ from: `${YEAR}-11-30`, to: `${YEAR}-11-01` })).size === 0, "a reversed range returns nothing rather than throwing");

    // THE QUERY-COUNT ASSERTION: count real driver calls across a 120-day window.
    let finds = 0;
    const realFind = AuspiciousDate.find.bind(AuspiciousDate);
    AuspiciousDate.find = (...args) => { finds++; return realFind(...args); };
    let findOnes = 0;
    const realFindOne = AuspiciousDate.findOne.bind(AuspiciousDate);
    AuspiciousDate.findOne = (...args) => { findOnes++; return realFindOne(...args); };
    try {
      const wide = await aus.lookupRange({ from: `${YEAR}-09-01`, to: `${YEAR}-12-30`, region: "Karnataka" });
      ok(finds === 1, `a 120-day window is ONE query (got ${finds})`);
      // 5 in November (the 25th's national + Karnataka rows merge to ONE key)
      // plus 1 in December.
      ok(wide.size === 6, `…and still returns every hit in it, merged per date (got ${wide.size})`);
      finds = 0;
      await aus.auspiciousKeys({ from: `${YEAR}-09-01`, to: `${YEAR}-12-30` });
      ok(finds === 1, "auspiciousKeys is one query too");
      await aus.isAuspicious(`${YEAR}-11-25`);
      ok(findOnes === 1, "the single-date helper is one findOne, not a range scan");
    } finally {
      AuspiciousDate.find = realFind;
      AuspiciousDate.findOne = realFindOne;
    }

    // ── day-key / IST correctness ───────────────────────────────────────────
    console.log("\n[day keys, not instants]");
    ok(aus.toDayKey(`${YEAR}-11-25`) === `${YEAR}-11-25`, "a day-key string round-trips");
    ok(aus.toDayKey(new Date(Date.UTC(YEAR, 10, 25))) === `${YEAR}-11-25`, "a stored midnight-UTC key reads back as the same calendar day");
    // 20:30Z on the 25th is 02:00 IST on the 26th — the date a couple would say.
    ok(aus.toDayKey(new Date(Date.UTC(YEAR, 10, 25, 20, 30))) === `${YEAR}-11-26`, "a real instant is bucketed into the INDIAN calendar day");
    ok(aus.toDayKey("nonsense") === null && aus.toDayKey(null) === null, "unparseable input is null, never a wrong date");
    ok(await aus.isAuspicious(new Date(Date.UTC(YEAR, 10, 25))), "isAuspicious accepts a Date as well as a key");

    // ── PATCH / DELETE ──────────────────────────────────────────────────────
    console.log("\n[edit + remove]");
    const target = await AuspiciousDate.findOne({ year: YEAR, month: 11, day: 20 }).lean();
    const patched = await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) }, body: { tier: "major", notes: "peak" } }));
    ok(patched.code === 200 && patched.body.date.tier === "major", "PATCH sets the tier");
    ok(patched.body.date.notes === "peak", "…and the notes");
    const cleared = await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) }, body: { tier: null } }));
    ok(cleared.code === 200 && cleared.body.date.tier === null, "…and clearing it back to unspecified is allowed");

    const moved = await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) }, body: { region: "Kerala" } }));
    ok(moved.code === 200 && moved.body.date.region === "Kerala", "PATCH moves a row's region");
    ok(!(await aus.isAuspicious(`${YEAR}-11-20`)), "…so it stops being national");
    ok(await aus.isAuspicious(`${YEAR}-11-20`, "Kerala"), "…and starts being Kerala's");
    await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) }, body: { region: "" } }));
    ok(await aus.isAuspicious(`${YEAR}-11-20`), "…and an empty region puts it back to national");

    // A REAL collision: the 25th already has both a national and a Karnataka
    // row, so pushing the national one into Karnataka lands on a taken key.
    const nov25National = await AuspiciousDate.findOne({ year: YEAR, month: 11, day: 25, region: null }).lean();
    const conflict = await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(nov25National._id) }, body: { region: "Karnataka" } }));
    ok(conflict.code === 409, "moving a row onto an existing (date, region) → 409, not a crash");
    ok((await AuspiciousDate.findById(nov25National._id).lean()).region === null, "…and the row it tried to move is untouched");

    const immutable = await call(ctl.updateAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) }, body: { date: `${YEAR}-11-27` } }));
    ok(immutable.code === 400, "the date itself cannot be edited");

    const del = await call(ctl.deleteAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) } }));
    ok(del.code === 200, "DELETE → 200");
    ok(!(await aus.isAuspicious(`${YEAR}-11-20`)), "…and the date stops resolving");
    ok((await call(ctl.deleteAuspiciousDate, adminReq(manager._id, { params: { id: String(target._id) } }))).code === 404, "deleting it twice → 404");

    // ── admin list filters ──────────────────────────────────────────────────
    console.log("\n[admin list]");
    const listed = await call(ctl.listAuspiciousDates, adminReq(manager._id, { query: { year: String(YEAR), month: "11" } }));
    ok(listed.code === 200 && listed.body.dates.every((d) => d.month === 11), "list filters by year+month");
    const listedRegion = await call(ctl.listAuspiciousDates, adminReq(manager._id, { query: { year: String(YEAR), region: "Karnataka" } }));
    ok(listedRegion.body.dates.every((d) => d.region === "Karnataka"), "…and by region");
    const listedNational = await call(ctl.listAuspiciousDates, adminReq(manager._id, { query: { year: String(YEAR), region: "" } }));
    ok(listedNational.body.dates.every((d) => d.region === null), "an EMPTY region filter means national-only, not 'any'");
    ok((await call(ctl.listAuspiciousDates, adminReq(manager._id, { query: { month: "13" } }))).code === 400, "month=13 → 400");

    // ── venue-owner read ────────────────────────────────────────────────────
    console.log("\n[venue-owner read surface]");
    const kaVenue = await Venue.create({ name: `${TAG}-ka`, slug: `${TAG}-ka`, city: "Bangalore", state: "Karnataka" });
    const tnVenue = await Venue.create({ name: `${TAG}-tn`, slug: `${TAG}-tn`, city: "Chennai", state: "Tamil Nadu" });
    created.venues.push(kaVenue._id, tnVenue._id);

    const kaRes = await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: `${YEAR}-11-01`, to: `${YEAR}-11-30` } }));
    ok(kaRes.code === 200, "owner read → 200");
    ok(kaRes.body.keys.includes(`${YEAR}-11-22`), "a Karnataka venue sees the Karnataka date");
    ok(!kaRes.body.keys.includes(`${YEAR}-11-23`), "…and not Tamil Nadu's");
    ok(kaRes.body.keys.includes(`${YEAR}-11-25`), "…and every national date");
    ok(kaRes.body.regions.includes("Karnataka"), "…and the response says which regions it resolved for");

    const tnRes = await call(getVenueAuspiciousDates, ownerReq(tnVenue, { query: { from: `${YEAR}-11-01`, to: `${YEAR}-11-30` } }));
    ok(tnRes.body.keys.includes(`${YEAR}-11-23`) && !tnRes.body.keys.includes(`${YEAR}-11-22`), "the Tamil Nadu venue sees the mirror image");

    const shaped = kaRes.body.dates.find((d) => d.date === `${YEAR}-11-25`);
    ok(shaped && shaped.auspicious === true && "tier" in shaped, "each row carries auspicious + tier for a date detail");

    // Cross-venue and range guards.
    const foreign = await call(getVenueAuspiciousDates, { ...ownerReq(kaVenue), params: { slug: tnVenue.slug } });
    ok(foreign.code === 403, "asking for another venue's slug with this token → 403");
    ok((await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: "not-a-date" } }))).code === 400, "a malformed from → 400");
    ok((await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: `${YEAR}-01-01`, to: `${YEAR + 3}-01-01` } }))).code === 400, "a 3-year range → 400 (capped)");
    ok((await call(getVenueAuspiciousDates, ownerReq(kaVenue, { query: { from: `${YEAR}-11-30`, to: `${YEAR}-11-01` } }))).code === 400, "to before from → 400");
    const defaulted = await call(getVenueAuspiciousDates, ownerReq(kaVenue, {}));
    ok(defaulted.code === 200 && defaulted.body.from && defaulted.body.to, "no params → a default forward window, echoed back");

    // A venue with no region set still gets the national calendar.
    const bare = await Venue.create({ name: `${TAG}-bare`, slug: `${TAG}-bare`, city: "", state: "" });
    created.venues.push(bare._id);
    const bareRes = await call(getVenueAuspiciousDates, ownerReq(bare, { query: { from: `${YEAR}-11-01`, to: `${YEAR}-11-30` } }));
    ok(bareRes.body.keys.includes(`${YEAR}-11-25`), "a venue with no region still gets national dates");
    ok(!bareRes.body.keys.includes(`${YEAR}-11-22`), "…and no regional ones");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    await Promise.all([
      AuspiciousDate.deleteMany({ year: YEAR }),
      Venue.deleteMany({ _id: { $in: created.venues } }),
      Admin.deleteMany({ _id: { $in: created.admins } }),
      Role.deleteMany({ _id: { $in: created.roles } }),
      Department.deleteMany({ _id: { $in: created.depts } }),
    ]).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

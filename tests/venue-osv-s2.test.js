// MB-OSV S2 — the two tracks in the directory.
// Run: node tests/venue-osv-s2.test.js
//
// The risk this suite exists for: the directory derives the badges in a MONGO
// AGGREGATION, while every other read derives them in JS (utils/venueTracks).
// Two implementations of one rule drift silently, and the drift shows up as a
// venue that carries a badge in the list and not on its own page. So the core
// assertion here is not "the pipeline works" — it is "the pipeline and the JS
// agree, venue by venue, across every combination of the two tracks".
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const VenueActivity = require("../models/VenueActivity");

const ops = require("../controllers/adminVenueOps");
const p = require("../controllers/adminVenuePartnership");
const tracks = require("../utils/venueTracks");

const TAG = `osv-s2-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const req = (adminId, extra = {}) => ({ params: extra.params || {}, query: extra.query || {}, body: extra.body || {}, auth: { user_id: adminId } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };

const created = { venues: [], admins: [], roles: [], depts: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    const viewerRole = await Role.create({ name: `${TAG}-viewer`, departmentId: dept._id, permissions: ["venues:view:all"] });
    created.roles.push(founderRole._id, viewerRole._id);
    const founder = await Admin.create({ name: `${TAG}-f`, email: `${TAG}-f@w.in`, phone: `${TAG}1`, password: "x", roleIds: [founderRole._id], departmentId: dept._id });
    const viewer = await Admin.create({ name: `${TAG}-v`, email: `${TAG}-v@w.in`, phone: `${TAG}2`, password: "x", roleIds: [viewerRole._id], departmentId: dept._id });
    created.admins.push(founder._id, viewer._id);

    const D = new Date();
    const mk = async (key, extra) => {
      const v = await Venue.create({ name: `${TAG}-${key}`, slug: `${TAG}-${key}`, ...extra });
      created.venues.push(v._id);
      return v;
    };

    // A matrix spanning both tracks, INCLUDING the combinations that only
    // exist because the tracks are independent.
    await mk("raw", {});
    await mk("legacy-verified", { status: "verified" });
    await mk("verified-never-approached", { verified: { isVerified: true, verifiedAt: D } });
    await mk("partner-unverified", {
      verified: { isVerified: false },
      partner: { accessGrantedAt: D, firstOwnerLoginAt: D, accessGrantTrigger: "wedsy_select" },
    });
    await mk("granted-no-login", { partner: { accessGrantedAt: D, accessGrantTrigger: "claim_approval" } });
    await mk("onboarded", {
      partner: { accessGrantedAt: D, firstOwnerLoginAt: D, onboarding: { status: "complete" } },
    });
    await mk("enriching", { enrichment: { completeness: 40, missingFields: ["pricing"], lastEnrichedAt: D } });
    await mk("enriched", { enrichment: { completeness: 95, missingFields: [], lastEnrichedAt: D } });
    await mk("scraped", { entryPoint: "scraped" });
    await mk("walkup", { entryPoint: "walk_up" });

    const dir = async (query = {}) =>
      call(ops.directory, req(founder._id, { query: { search: TAG, limit: 100, ...query } }));

    // ── 1. pipeline vs JS, venue by venue ───────────────────────────────────
    console.log("\n[1] the aggregation and utils/venueTracks agree");
    const all = await dir();
    ok(all.code === 200, "directory → 200");
    ok(all.body.venues.length === 10, `all ten fixtures returned (got ${all.body.venues.length})`);

    const docs = await Venue.find({ slug: { $regex: `^${TAG}` } }).lean();
    const byslug = Object.fromEntries(docs.map((d) => [d.slug, d]));
    let agree = 0;
    for (const row of all.body.venues) {
      const doc = byslug[row.slug];
      const wantVerified = tracks.verifiedBadge(doc);
      const wantPartner = tracks.partnerBadge(doc);
      const wantEnrich = tracks.enrichmentStage(doc);
      const wantPartnerStage = tracks.partnerStage(doc);
      const matched =
        row.verifiedBadge === wantVerified &&
        row.partnerBadge === wantPartner &&
        row.enrichmentStage === wantEnrich &&
        row.partnerStage === wantPartnerStage;
      if (!matched) {
        console.error(`      drift on ${row.slug}: pipeline`,
          { v: row.verifiedBadge, p: row.partnerBadge, e: row.enrichmentStage, s: row.partnerStage },
          "js", { v: wantVerified, p: wantPartner, e: wantEnrich, s: wantPartnerStage });
      } else agree++;
    }
    ok(agree === all.body.venues.length, `all ${all.body.venues.length} venues derive identically in both implementations`);

    // The legacy fallback has to survive into the pipeline too.
    const legacy = all.body.venues.find((v) => v.slug.endsWith("legacy-verified"));
    ok(legacy.verifiedBadge === true, "the pipeline honours the legacy status fallback");

    // ── 2. the tracks filter INDEPENDENTLY ──────────────────────────────────
    console.log("\n[2] independent facets");
    const verifiedOnly = await dir({ verified: "true" });
    const vSlugs = verifiedOnly.body.venues.map((v) => v.slug);
    ok(vSlugs.some((s) => s.endsWith("verified-never-approached")), "verified=true finds a venue with NO partnership");
    ok(vSlugs.some((s) => s.endsWith("legacy-verified")), "…and the legacy one");
    ok(!vSlugs.some((s) => s.endsWith("partner-unverified")), "…and excludes a live partner that is not verified");

    const partnersOnly = await dir({ partnerStage: "live" });
    const pSlugs = partnersOnly.body.venues.map((v) => v.slug);
    ok(pSlugs.some((s) => s.endsWith("partner-unverified")), "partnerStage=live finds an UNVERIFIED partner");
    ok(!pSlugs.some((s) => s.endsWith("granted-no-login")), "…and excludes access-granted-but-never-logged-in");
    ok(!pSlugs.some((s) => s.endsWith("onboarded")), "…and excludes the onboarding-complete one (its own stage)");

    const granted = await dir({ partnerStage: "access_granted" });
    ok(granted.body.venues.length === 1 && granted.body.venues[0].slug.endsWith("granted-no-login"),
      "partnerStage=access_granted isolates the half-done partnership");

    // The combination that proves independence: verified AND not a partner.
    const crossed = await dir({ verified: "true", partnerStage: "none" });
    ok(crossed.body.venues.some((v) => v.slug.endsWith("verified-never-approached")),
      "verified + partnerStage=none is a representable, findable state");

    const unverifiedPartners = await dir({ verified: "false", partnerStage: "live" });
    ok(unverifiedPartners.body.venues.some((v) => v.slug.endsWith("partner-unverified")),
      "…and so is its mirror image: a live partner nobody has checked");

    // ── 3. Track A stage facet + entry points ───────────────────────────────
    console.log("\n[3] enrichment stages and entry points");
    for (const [stage, slugEnd] of [["raw", "raw"], ["enriching", "enriching"], ["enriched", "enriched"]]) {
      const r = await dir({ enrichmentStage: stage });
      ok(r.body.venues.every((v) => v.enrichmentStage === stage), `enrichmentStage=${stage} returns only that stage`);
      if (slugEnd !== "raw") {
        ok(r.body.venues.some((v) => v.slug.endsWith(slugEnd)), `…and includes the ${slugEnd} fixture`);
      }
    }
    const scraped = await dir({ entryPoint: "scraped" });
    ok(scraped.body.venues.length === 1 && scraped.body.venues[0].slug.endsWith("scraped"), "entryPoint=scraped filters");
    const walkup = await dir({ entryPoint: "walk_up" });
    ok(walkup.body.venues.length === 1, "entryPoint=walk_up filters");
    ok(all.body.venues.every((v) => "entryPoint" in v), "every row carries its entry point");

    // ── 4. bad facet values are rejected, not ignored ───────────────────────
    console.log("\n[4] validation");
    for (const [q, label] of [
      [{ enrichmentStage: "sparkling" }, "enrichmentStage"],
      [{ partnerStage: "besties" }, "partnerStage"],
      [{ verified: "maybe" }, "verified"],
      [{ onboardingStatus: "vibes" }, "onboardingStatus"],
      [{ entryPoint: "teleported" }, "entryPoint"],
    ]) {
      const r = await dir(q);
      ok(r.code === 400, `unknown ${label} → 400 (not silently ignored)`);
    }

    // ── 5. bulk Track A ─────────────────────────────────────────────────────
    console.log("\n[5] bulk actions");
    const targets = [`${TAG}-raw`, `${TAG}-scraped`];
    const bv = await call(p.bulk, req(founder._id, { body: { action: "verify", slugs: targets, notes: "sweep" } }));
    ok(bv.code === 200 && bv.body.modified === 2, "bulk verify → 200, both modified");
    const afterVerify = await dir({ verified: "true" });
    ok(targets.every((s) => afterVerify.body.venues.some((v) => v.slug === s)), "…and both now read verified in the directory");

    const be = await call(p.bulk, req(founder._id, { body: { action: "enrich", slugs: targets, completeness: 90, missingFields: [] } }));
    ok(be.code === 200, "bulk enrich → 200");
    const afterEnrich = await dir({ enrichmentStage: "enriched" });
    ok(targets.every((s) => afterEnrich.body.venues.some((v) => v.slug === s)), "…and both advanced to enriched");

    const bu = await call(p.bulk, req(founder._id, { body: { action: "unverify", slugs: targets } }));
    ok(bu.code === 200, "bulk unverify → 200");
    const afterUnverify = await dir({ verified: "false" });
    ok(targets.every((s) => afterUnverify.body.venues.some((v) => v.slug === s)), "…and both read unverified again");

    // Capability is re-checked INSIDE the handler, per action.
    const deniedVerify = await call(p.bulk, req(viewer._id, { body: { action: "verify", slugs: targets } }));
    ok(deniedVerify.code === 403, "a venues:view-only admin is DENIED bulk verify");
    const deniedEnrich = await call(p.bulk, req(viewer._id, { body: { action: "enrich", slugs: targets } }));
    ok(deniedEnrich.code === 403, "…and bulk enrich");
    ok(deniedVerify.body.required === "venues_verify:edit:all", "…and the denial names the capability it wanted");

    for (const [body, label] of [
      [{ action: "grant_access", slugs: targets }, "Track B is not bulkable"],
      [{ action: "verify", slugs: [] }, "empty selection"],
      [{ action: "verify", slugs: ["ghost-venue"] }, "unknown slug"],
      [{ action: "verify", slugs: targets, completeness: 5 }, "…"],
    ].slice(0, 3)) {
      const r = await call(p.bulk, req(founder._id, { body }));
      ok(r.code === 400, `${label} → 400`);
    }
    const tooMany = await call(p.bulk, req(founder._id, { body: { action: "verify", slugs: Array(201).fill("x") } }));
    ok(tooMany.code === 400, "over 200 venues in one bulk → 400");

    // ── 6. bulk is audited per venue ────────────────────────────────────────
    console.log("\n[6] bulk writes the audit trail");
    await new Promise((r) => setTimeout(r, 200));
    const acts = await VenueActivity.find({ venue: { $in: created.venues } }).lean();
    const verifyEntries = acts.filter((a) => a.action === "venue_verified");
    ok(verifyEntries.length >= 2, "a bulk verify logs ONE entry PER VENUE, not one for the batch");
    ok(verifyEntries.every((a) => a.severity === "high"), "…each at high severity");
    ok(acts.some((a) => a.action === "venue_unverified"), "bulk unverify is logged too");

  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    await Promise.all([
      Venue.deleteMany({ _id: { $in: created.venues } }),
      VenueActivity.deleteMany({ venue: { $in: created.venues } }),
      Admin.deleteMany({ _id: { $in: created.admins } }),
      Role.deleteMany({ _id: { $in: created.roles } }),
      Department.deleteMany({ _id: { $in: created.depts } }),
    ]).catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

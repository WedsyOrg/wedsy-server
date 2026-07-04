/**
 * scripts/e2e-competitive.js — deterministic checks for Phase 4.3 competitor
 * insights (controllers/venueCompetitive.computeCompetitive). DB-backed but
 * fully self-contained: seeds an isolated cohort in a throwaway zone, asserts
 * the anonymized aggregates + both suppression modes, then deletes everything
 * it created. No server, no network.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a local Mongo host.
 * Usage: node scripts/e2e-competitive.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueView = require("../models/VenueView");
const { computeCompetitive } = require("../controllers/venueCompetitive");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
// Isolate the test cohort by an UNUSED zone ("") + a unique locality tag, so it
// keys off locality and never collides with real published venues in any zone.
const ZONE = "";
const LOCALITY = "zz-competitive-test";
const SPARSE_LOCALITY = "zz-competitive-sparse";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ PASS  ${name}`); }
  else { fail++; console.log(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function assertLocal() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try { host = new URL(url).hostname; } catch (e) { throw new Error(`bad DATABASE_URL: ${e.message}`); }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing: DATABASE_URL host "${host}" is not local.`);
  return host;
}

async function makeVenue(slug, { veg, rating, locality }) {
  return Venue.create({
    name: slug, slug, status: "published", city: "Bangalore",
    venueType: "banquet_hall", zone: ZONE, locality,
    pricing: { perPlate: { veg } },
    googleRating: rating,
  });
}

async function addEnquiries(venueId, { total, booked }) {
  const docs = [];
  for (let i = 0; i < total; i++) {
    docs.push({
      venueId,
      coupleName: `zz cohort lead ${i}`,
      couplePhone: String(7000000000 + Math.floor(Math.random() * 1e8)),
      stage: i < booked ? "booked" : "new",
      source: "other",
      createdAt: new Date(), // within 30d & 90d windows
    });
  }
  if (docs.length) await VenueEnquiry.insertMany(docs);
}

async function addViews(venueId, n) {
  const docs = Array.from({ length: n }, (_, i) => ({ venueId, venueSlug: "zz", sessionHash: `zz${i}`, viewedAt: new Date() }));
  if (docs.length) await VenueView.insertMany(docs);
}

async function cleanup() {
  const venues = await Venue.find({ locality: { $in: [LOCALITY, SPARSE_LOCALITY] } }).select("_id").lean();
  const ids = venues.map((v) => v._id);
  await VenueEnquiry.deleteMany({ venueId: { $in: ids } });
  await VenueView.deleteMany({ venueId: { $in: ids } });
  await Venue.deleteMany({ _id: { $in: ids } });
}

async function run() {
  const host = assertLocal();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[e2e-competitive] connected to local Mongo @ ${host}`);
  await cleanup(); // idempotent: clear any prior run

  // ── Cohort of 6 in zone south / locality zz-competitive-test ──
  // veg prices: 1000,1200,1400,1500,1600,1800 ; ratings: 4.0,4.2,4.4,4.6,4.6,4.8
  // target = the 1500 / 4.6 venue.
  const specs = [
    { slug: "zz-cohort-1", veg: 1000, rating: 4.0, enq: { total: 10, booked: 1 }, views: 100 },
    { slug: "zz-cohort-2", veg: 1200, rating: 4.2, enq: { total: 20, booked: 4 }, views: 200 },
    { slug: "zz-cohort-3", veg: 1400, rating: 4.4, enq: { total: 30, booked: 6 }, views: 300 },
    { slug: "zz-target",   veg: 1500, rating: 4.6, enq: { total: 40, booked: 8 }, views: 0 },
    { slug: "zz-cohort-5", veg: 1600, rating: 4.6, enq: { total: 50, booked: 10 }, views: 0 },
    { slug: "zz-cohort-6", veg: 1800, rating: 4.8, enq: { total: 60, booked: 18 }, views: 0 },
  ];
  const created = {};
  for (const s of specs) {
    const v = await makeVenue(s.slug, { veg: s.veg, rating: s.rating, locality: LOCALITY });
    created[s.slug] = v;
    await addEnquiries(v._id, s.enq);
    if (s.views) await addViews(v._id, s.views);
  }

  const target = await Venue.findById(created["zz-target"]._id).select("_id zone locality pricing googleRating").lean();
  const out = await computeCompetitive(target);

  check("cohortSize === 6, not suppressedAll", out.cohortSize === 6 && out.suppressedAll === false, `size=${out.cohortSize}`);

  // enquiries (all created "now" → all in 30d & 90d). cohort avg30 = mean totals
  // = (10+20+30+40+50+60)/6 = 35. target you30 = 40.
  const enq = out.metrics.enquiries;
  check("enquiries: you30=40, cohortAvg30=35", enq.you30 === 40 && enq.cohortAvg30 === 35, JSON.stringify(enq));

  // booked rate: cohort avg of booked/total*100:
  // 10,20,20,20,20,30 -> /6 = 20.0 ; target = 8/40 = 20.0
  const bk = out.metrics.booking;
  check("booking: you=20, cohortAvg=20", bk.you === 20 && bk.cohortAvg === 20, JSON.stringify(bk));

  // price: [1000,1200,1400,1500,1600,1800] -> median 1450, q1 1250, q3 1575 ;
  // target 1500 sits between q1 and q3 -> "mid".
  const pr = out.metrics.price;
  check("price: median=1450, q1=1250, q3=1575, you=1500, position=mid",
    pr.cohortMedian === 1450 && pr.cohortQ1 === 1250 && pr.cohortQ3 === 1575 && pr.you === 1500 && pr.position === "mid",
    JSON.stringify(pr));

  // rating: avg of [4.0,4.2,4.4,4.6,4.6,4.8] = 4.4333 -> 4.4 ; you 4.6
  const rt = out.metrics.rating;
  check("rating: you=4.6, cohortAvg=4.4", rt.you === 4.6 && rt.cohortAvg === 4.4, JSON.stringify(rt));

  // conversion: only 3 venues have views (< MIN_COHORT 5) -> suppressed
  check("conversion: suppressed (only 3 of 6 have views)", out.metrics.conversion.suppressed === true && out.metrics.conversion.minCohort === 5, JSON.stringify(out.metrics.conversion));

  // NEVER leak per-competitor data: payload carries no other venue ids/names/slugs
  const blob = JSON.stringify(out);
  const leaks = ["zz-cohort-1", "zz-cohort-6", String(created["zz-cohort-1"]._id)].filter((s) => blob.includes(s));
  check("privacy: no per-competitor identifiers in payload", leaks.length === 0, `leaks=${leaks.join(",")}`);

  // ── Sparse zone: a 3-venue cohort -> whole thing suppressed (cohort < 5) ──
  for (let i = 0; i < 3; i++) {
    const v = await makeVenue(`zz-sparse-${i}`, { veg: 1000 + i * 100, rating: 4.0, locality: SPARSE_LOCALITY });
    // override zone so it doesn't join the "south" cohort
    await Venue.updateOne({ _id: v._id }, { $set: { zone: "", locality: SPARSE_LOCALITY } });
  }
  const sparseTarget = await Venue.findOne({ locality: SPARSE_LOCALITY }).select("_id zone locality pricing googleRating").lean();
  const sparseOut = await computeCompetitive(sparseTarget);
  check("sparse cohort (n=3 < 5): every metric suppressed",
    sparseOut.cohortSize === 3 &&
      ["enquiries", "conversion", "booking", "price", "rating"].every((k) => sparseOut.metrics[k].suppressed === true),
    `size=${sparseOut.cohortSize}`);

  await cleanup();
  await mongoose.disconnect();
  console.log(`\n[e2e-competitive] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error("[e2e-competitive] fatal:", e.message);
  try { await cleanup(); await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

/* eslint-disable no-console */
//
// enrich-meragi.js — Meragi enrichment scraper + data-quality fixer.
//
// Two phases:
//   PART 1  Fix existing data-quality issues in the DB (run FIRST):
//             1) Normalize scrapedFrom casing (array-element level).
//             2) Repair amenities that were stored as an array → object.
//   PART 2  Re-scrape each Meragi venue's public page (Puppeteer, headless)
//           for structured data (amenities, capacity, spaces, pricing,
//           accommodation) and MERGE it in WITHOUT ever overwriting existing
//           non-empty data.
//
// Safe by construction: every write is additive ($set of dot-paths only),
// gated on the current value being empty/false. Per-venue try/catch so one
// bad page never aborts the run.
//
// Usage:  node scripts/enrich-meragi.js
// Requires puppeteer (npm install puppeteer) — same dependency the existing
// scrape-wmg-airport-venues.js uses.
//
require("dotenv").config();
const mongoose = require("mongoose");
const puppeteer = require("puppeteer");

const Venue = require("../models/Venue");

const MONGO_URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

// --dry-run: run all scraping + matching + merge computation, but make ZERO
// writes to MongoDB. Both the Part 1 data fixes and the Part 2 enrichment
// writes are suppressed; instead we report what WOULD change.
const DRY_RUN = process.argv.includes("--dry-run");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const PAGE_DELAY_MS = 1000; // polite delay between Meragi page fetches
const NAME_MATCH_THRESHOLD = 0.7; // ≥70% char overlap = same venue
const COORD_MATCH_METERS = 500; // within 500m = same venue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/^a\s+/i, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Meragi slug per spec: lowercase, non-alnum → single dash, trim edge dashes.
function generateSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Loose name match: substring either way, else positional char-overlap ratio.
// Mirrors the fuzzyMatch heuristic used on the venues listing page.
function fuzzyMatch(input, target) {
  const a = normalizeName(input).replace(/\s+/g, "");
  const b = normalizeName(target).replace(/\s+/g, "");
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / Math.max(a.length, b.length) > NAME_MATCH_THRESHOLD;
}

// Great-circle distance in metres between two [lng, lat] pairs.
function haversineMeters(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Build the Meragi URL for a venue: prefer an existing meragi.com website,
// otherwise fall back to the city/slug pattern.
function buildMeragiUrl(venue) {
  const sites = [venue.website, venue.contact && venue.contact.website].filter(Boolean);
  const direct = sites.find((s) => /meragi\.com/i.test(s));
  if (direct) return direct;
  return `https://meragi.com/venues/bangalore/${generateSlug(venue.name)}`;
}

// Map free-text amenity labels found on a Meragi page → Venue.amenities keys.
// Keys must exactly match the schema in models/Venue.js.
const AMENITY_KEYWORDS = [
  { key: "swimmingPool", re: /swimming pool|\bpool\b/i },
  { key: "airConditioning", re: /air conditioning|air-conditioned|\bac\b|a\/c/i },
  { key: "generatorBackup", re: /generator|power backup|dg backup/i },
  { key: "parking", re: /\bparking\b/i },
  { key: "valetParking", re: /valet/i },
  { key: "garden", re: /outdoor lawn|garden|lawn/i },
  { key: "helipad", re: /helipad/i },
  { key: "bridalSuite", re: /bridal (suite|room)/i },
  { key: "groomRoom", re: /groom('?s)? room/i },
  { key: "makeupRoom", re: /makeup room|make-up room/i },
  { key: "changingRooms", re: /changing room/i },
  { key: "prayerRoom", re: /prayer room|pooja room/i },
  { key: "wifi", re: /wi-?fi/i },
  { key: "cctv", re: /cctv|surveillance/i },
  { key: "elevator", re: /elevator|\blift\b/i },
  { key: "fireNOC", re: /fire noc|fire safety/i },
  { key: "liquorLicense", re: /liquor licen[cs]e|bar licen[cs]e/i },
  { key: "dayOfCoordinator", re: /day[- ]of coordinator|event coordinator|wedding coordinator/i },
  { key: "securityStaff", re: /security (staff|guard)/i },
  { key: "housekeeping", re: /housekeeping/i },
  { key: "shuttleService", re: /shuttle/i },
  { key: "petFriendly", re: /pet[- ]friendly|pets allowed/i },
];

// Indoor hall / indoor space hint — used to tag a generic space type.
const INDOOR_HINT = /indoor|hall|banquet|convention|ballroom/i;
const OUTDOOR_HINT = /outdoor|lawn|garden|terrace|poolside|open[- ]air/i;

// ---------------------------------------------------------------------------
// PART 1 — Data-quality fixes
// ---------------------------------------------------------------------------

// Fix 1 — normalize scrapedFrom casing. scrapedFrom is an ARRAY of strings, so
// we rewrite only the matching element (arrayFilters) to avoid clobbering a
// venue that legitimately lists multiple sources. We match case-insensitively
// but skip elements already in canonical form, so the reported count reflects
// real changes only.
async function fixScrapedFromCasing(dryRun) {
  const CANONICAL = [
    { canonical: "WedMeGood", re: "^wedmegood$" },
    { canonical: "TheWeddingCompany", re: "^theweddingcompany$" },
    { canonical: "Meragi", re: "^meragi$" },
  ];

  let totalFixed = 0;
  for (const { canonical, re } of CANONICAL) {
    const filter = { scrapedFrom: { $regex: re, $options: "i", $ne: canonical } };
    let n;
    if (dryRun) {
      n = await Venue.countDocuments(filter);
    } else {
      const res = await Venue.updateMany(
        filter,
        { $set: { "scrapedFrom.$[elem]": canonical } },
        { arrayFilters: [{ elem: { $regex: re, $options: "i", $ne: canonical } }] },
      );
      n = res.modifiedCount || 0;
    }
    if (n > 0) {
      console.log(`  [fix1] ${canonical}: ${dryRun ? "would normalize" : "normalized"} ${n} venue(s)`);
    }
    totalFixed += n;
  }
  return totalFixed;
}

// Fix 2 — repair amenities stored as an array (legacy/scraper artifact) by
// resetting them to an empty object so the object-shaped schema is consistent.
// Spec asks for a per-venue find + updateOne loop with a reported count.
async function fixAmenitiesShape(dryRun) {
  const venues = await Venue.find({ amenities: { $type: "array" } })
    .select("_id name")
    .lean();
  if (dryRun) return venues.length;
  let fixed = 0;
  for (const v of venues) {
    try {
      await Venue.updateOne({ _id: v._id }, { $set: { amenities: {} } });
      fixed++;
    } catch (e) {
      console.warn(`  [fix2] ${v.name}: ${e.message}`);
    }
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// PART 2 — Meragi page scraping
// ---------------------------------------------------------------------------

// Scrape a single Meragi venue page. Returns a structured object, or a marker
// object on failure: { __notFound: true } | { __error: "..." }.
//
// NOTE: Meragi's exact DOM is not known here, so extraction is intentionally
// heuristic — it reads visible page text and applies keyword/regex rules
// rather than relying on brittle CSS selectors. Tune the selectors/regexes
// against the live site before trusting the output.
async function scrapeMeragiPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const status = resp ? resp.status() : 0;
    if (status === 404) return { __notFound: true, status };
    if (status >= 400) return { __error: `HTTP ${status}` };

    await sleep(1200);
    // Nudge lazy-loaded sections into the DOM.
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(400);
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(400);

    const data = await page.evaluate(
      (AMENITY_SRC, INDOOR_SRC, OUTDOOR_SRC) => {
        const amenityRules = AMENITY_SRC.map((a) => ({ key: a.key, re: new RegExp(a.source, a.flags) }));
        const indoorHint = new RegExp(INDOOR_SRC.source, INDOOR_SRC.flags);
        const outdoorHint = new RegExp(OUTDOOR_SRC.source, OUTDOOR_SRC.flags);

        const bodyText = (document.body.innerText || "").replace(/ /g, " ");
        const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);

        // ---- Name (single h1) ----
        const name = ((document.querySelector("h1")?.innerText || "").trim().split("\n")[0]) || "";

        // ---- Amenities ----
        const amenities = {};
        for (const { key, re } of amenityRules) {
          if (re.test(bodyText)) amenities[key] = true;
        }
        // Parking capacity if a number is mentioned alongside parking.
        const parkCap = bodyText.match(/parking[^\d]{0,30}(\d{2,4})\s*(?:cars?|vehicles?|slots?)/i);
        if (parkCap) amenities.parkingCapacity = parseInt(parkCap[1], 10);
        // Outside alcohol policy.
        if (/outside alcohol allowed|byob|bring your own/i.test(bodyText)) amenities.outsideAlcohol = "yes";

        // ---- Capacity (max guest count) ----
        let capacityMax = 0;
        let capacitySeated = 0;
        const capMatches = bodyText.match(/(\d{2,5})\s*(?:pax|guests|people|persons|capacity)/gi) || [];
        for (const m of capMatches) {
          const n = parseInt((m.match(/\d{2,5}/) || ["0"])[0], 10);
          if (n > capacityMax) capacityMax = n;
        }
        const seatedM = bodyText.match(/(\d{2,5})\s*(?:seated|seating)/i);
        if (seatedM) capacitySeated = parseInt(seatedM[1], 10);

        // ---- Spaces ----
        // Best-effort: lines that look like a named hall/lawn with a capacity.
        const spaces = [];
        for (const line of lines) {
          if (line.length > 80) continue;
          const hasName = indoorHint.test(line) || outdoorHint.test(line);
          const capN = (line.match(/(\d{2,5})\s*(?:pax|guests|seated|capacity)/i) || [])[1];
          if (hasName && capN) {
            spaces.push({
              name: line.replace(/\s*[-–:]\s*\d.*$/, "").trim().slice(0, 80) || "Event Space",
              type: outdoorHint.test(line) ? "outdoor" : indoorHint.test(line) ? "indoor" : "semi-outdoor",
              capacitySeated: parseInt(capN, 10),
              capacityStanding: 0,
            });
          }
          if (spaces.length >= 12) break;
        }

        // ---- Pricing (per plate) ----
        const perPlate = { veg: 0, nonVeg: 0 };
        const vegM = bodyText.match(/(?:veg(?:etarian)?)[^\d₹]{0,20}₹?\s*(\d{2,5})\s*(?:\/|per)?\s*(?:plate|pax)?/i);
        const nonVegM = bodyText.match(/non[- ]?veg(?:etarian)?[^\d₹]{0,20}₹?\s*(\d{2,5})/i);
        if (vegM) perPlate.veg = parseInt(vegM[1], 10);
        if (nonVegM) perPlate.nonVeg = parseInt(nonVegM[1], 10);

        // ---- Accommodation ----
        const accommodation = { available: false, totalCapacity: 0, roomTypes: [] };
        const roomsM = bodyText.match(/(\d{1,4})\s*(?:rooms?|keys|suites?)/i);
        if (roomsM || /accommodation|stay options|on-site rooms/i.test(bodyText)) {
          const roomCount = roomsM ? parseInt(roomsM[1], 10) : 0;
          if (roomCount > 0) {
            accommodation.available = true;
            accommodation.totalCapacity = roomCount * 2; // 2 pax/room assumption
            accommodation.roomTypes = [
              { name: "Standard Room", count: roomCount, occupancyPerRoom: 2, maxPeoplePerRoom: 2 },
            ];
          }
        }

        return { name, amenities, capacityMax, capacitySeated, spaces, perPlate, accommodation };
      },
      AMENITY_KEYWORDS.map((a) => ({ key: a.key, source: a.re.source, flags: a.re.flags })),
      { source: INDOOR_HINT.source, flags: INDOOR_HINT.flags },
      { source: OUTDOOR_HINT.source, flags: OUTDOOR_HINT.flags },
    );

    return data;
  } catch (err) {
    return { __error: err.message };
  } finally {
    await page.close();
  }
}

// Decide whether a scraped page actually corresponds to the DB venue.
// Name fuzzy-match OR coordinate proximity (when both sides have coords).
function isSameVenue(venue, scraped, scrapedCoords) {
  if (scraped.name && fuzzyMatch(scraped.name, venue.name)) return true;
  if (
    scrapedCoords &&
    Array.isArray(venue.location?.coordinates) &&
    venue.location.coordinates.length === 2
  ) {
    const [vLng, vLat] = venue.location.coordinates;
    const d = haversineMeters(vLng, vLat, scrapedCoords[0], scrapedCoords[1]);
    if (d <= COORD_MATCH_METERS) return true;
  }
  return false;
}

// Build an additive $set from scraped data, honouring the never-overwrite
// rules. Returns { set, enriched: { amenities, pricing, spaces } }.
function buildMerge(venue, scraped) {
  const set = {};
  const enriched = { amenities: false, pricing: false, spaces: false };

  // --- amenities: only flip fields that are currently undefined/false ---
  const curAmen = venue.amenities && !Array.isArray(venue.amenities) ? venue.amenities : {};
  if (scraped.amenities) {
    for (const [k, v] of Object.entries(scraped.amenities)) {
      if (k === "parkingCapacity") {
        if (v > 0 && !(curAmen.parkingCapacity > 0)) {
          set["amenities.parkingCapacity"] = v;
          enriched.amenities = true;
        }
        continue;
      }
      if (k === "outsideAlcohol") {
        if (v === "yes" && (!curAmen.outsideAlcohol || curAmen.outsideAlcohol === "no")) {
          set["amenities.outsideAlcohol"] = "yes";
          enriched.amenities = true;
        }
        continue;
      }
      // boolean amenity flags
      if (v === true && !curAmen[k]) {
        set[`amenities.${k}`] = true;
        enriched.amenities = true;
      }
    }
  }

  // --- spaces: only if currently empty ---
  if (Array.isArray(scraped.spaces) && scraped.spaces.length > 0) {
    const curSpaces = Array.isArray(venue.spaces) ? venue.spaces : [];
    if (curSpaces.length === 0) {
      set.spaces = scraped.spaces;
      enriched.spaces = true;
    }
  }

  // --- pricing.perPlate: only if current veg is 0/undefined ---
  const curVeg = venue.pricing && venue.pricing.perPlate ? venue.pricing.perPlate.veg : undefined;
  if (scraped.perPlate && scraped.perPlate.veg > 0 && (!curVeg || curVeg === 0)) {
    set["pricing.perPlate.veg"] = scraped.perPlate.veg;
    if (scraped.perPlate.nonVeg > 0) set["pricing.perPlate.nonVeg"] = scraped.perPlate.nonVeg;
    enriched.pricing = true;
  }

  // --- accommodation: only set available if currently false AND rooms found ---
  const curAcc = venue.accommodation || {};
  if (scraped.accommodation && scraped.accommodation.available) {
    if (!curAcc.available) {
      set["accommodation.available"] = true;
      if (scraped.accommodation.totalCapacity > 0 && !(curAcc.totalCapacity > 0)) {
        set["accommodation.totalCapacity"] = scraped.accommodation.totalCapacity;
      }
    }
    // roomTypes only if currently empty
    const curRooms = Array.isArray(curAcc.roomTypes) ? curAcc.roomTypes : [];
    if (curRooms.length === 0 && scraped.accommodation.roomTypes.length > 0) {
      set["accommodation.roomTypes"] = scraped.accommodation.roomTypes;
    }
  }

  return { set, enriched };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");
  console.log(DRY_RUN ? "MODE: DRY RUN — no writes will be made\n" : "MODE: LIVE — writes enabled\n");

  const report = {
    processed: 0,
    scrapedFromFixes: 0,
    amenitiesShapeFixes: 0,
    enrichedAmenities: 0,
    enrichedPricing: 0,
    enrichedSpaces: 0,
    notFound: 0,
    errors: 0,
  };

  // ---- PART 1: data-quality fixes (run before scraping) ----
  console.log("PART 1 — data-quality fixes");
  report.scrapedFromFixes = await fixScrapedFromCasing(DRY_RUN);
  console.log(`  scrapedFrom casing fixes: ${report.scrapedFromFixes}${DRY_RUN ? " (would apply)" : ""}`);
  report.amenitiesShapeFixes = await fixAmenitiesShape(DRY_RUN);
  console.log(`  amenities shape fixes:    ${report.amenitiesShapeFixes}${DRY_RUN ? " (would apply)" : ""}\n`);

  // ---- PART 2: Meragi page scraping + merge ----
  console.log("PART 2 — Meragi page scraping");
  const venues = await Venue.find({ scrapedFrom: "Meragi" }).lean();
  console.log(`  Meragi venues to process: ${venues.length}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const dryRows = []; // { name, set } collected for the dry-run table

  try {
    for (const venue of venues) {
      report.processed++;
      const url = buildMeragiUrl(venue);
      try {
        const scraped = await scrapeMeragiPage(browser, url);

        if (scraped.__notFound) {
          report.notFound++;
          console.log(`  [404]  ${venue.name} — ${url}`);
          continue;
        }
        if (scraped.__error) {
          report.errors++;
          console.log(`  [err]  ${venue.name} — ${scraped.__error}`);
          continue;
        }

        // Verify the page is actually this venue before merging.
        if (!isSameVenue(venue, scraped, null)) {
          report.errors++;
          console.log(`  [skip] ${venue.name} — page name "${scraped.name}" did not match`);
          continue;
        }

        const { set, enriched } = buildMerge(venue, scraped);
        if (Object.keys(set).length === 0) {
          console.log(`  [ok]   ${venue.name} — nothing new to add`);
          continue;
        }

        // Tally enrichment in both modes so the report reflects what would/did happen.
        if (enriched.amenities) report.enrichedAmenities++;
        if (enriched.pricing) report.enrichedPricing++;
        if (enriched.spaces) report.enrichedSpaces++;

        if (DRY_RUN) {
          dryRows.push({ name: venue.name, set });
          console.log(`  [dry]  ${venue.name} — would set: ${Object.keys(set).join(", ")}`);
        } else {
          await Venue.updateOne({ _id: venue._id }, { $set: set });
          console.log(`  [+]    ${venue.name} — ${Object.keys(set).join(", ")}`);
        }
      } catch (e) {
        report.errors++;
        console.log(`  [err]  ${venue.name} — ${e.message}`);
      }
      await sleep(PAGE_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  // ---- PART 3: report ----
  console.log("\n──────── REPORT ────────");
  console.log(`Total Meragi venues processed:   ${report.processed}`);
  console.log(`scrapedFrom fixes applied:       ${report.scrapedFromFixes}`);
  console.log(`amenities shape fixes applied:   ${report.amenitiesShapeFixes}`);
  console.log(`Venues enriched (amenities):     ${report.enrichedAmenities}`);
  console.log(`Venues enriched (pricing):       ${report.enrichedPricing}`);
  console.log(`Venues enriched (spaces):        ${report.enrichedSpaces}`);
  console.log(`Pages not found (404):           ${report.notFound}`);
  console.log(`Errors / skips:                  ${report.errors}`);
  console.log("────────────────────────");

  // ---- Dry-run table: venue | field | value ----
  if (DRY_RUN) {
    console.log("\n──────── DRY RUN — proposed $set per venue (NOT written) ────────");
    if (dryRows.length === 0) {
      console.log("(no venues would be updated)");
    } else {
      const COL_VENUE = 28;
      const COL_FIELD = 30;
      console.log(
        `${"VENUE".padEnd(COL_VENUE)} | ${"FIELD".padEnd(COL_FIELD)} | VALUE`,
      );
      console.log(`${"-".repeat(COL_VENUE)}-+-${"-".repeat(COL_FIELD)}-+-${"-".repeat(20)}`);
      for (const row of dryRows) {
        let first = true;
        for (const [field, value] of Object.entries(row.set)) {
          let v = typeof value === "object" ? JSON.stringify(value) : String(value);
          if (v.length > 60) v = v.slice(0, 57) + "...";
          const venueCol = (first ? row.name : "").slice(0, COL_VENUE).padEnd(COL_VENUE);
          console.log(`${venueCol} | ${field.padEnd(COL_FIELD)} | ${v}`);
          first = false;
        }
      }
    }
    console.log("─────────────────────────────────────────────────────────────────");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FATAL:", err.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});

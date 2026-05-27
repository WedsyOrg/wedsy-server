/* eslint-disable no-console */
// Retry script for the 9 Meragi venues whose detail scrape failed during a
// prior seed run (browser timeouts / connection drops). For each slug we
// rebuild the Meragi detail URL, re-run the FIXED description extractor
// (anchored to "A perfect setting for your dream wedding."), and patch the
// fields the seed pipeline would have written: description, photos.venue,
// cateringPolicy.type, amenities.outsideAlcohol, accommodation totals.
//
// scrapeMeragiDetail is duplicated from seed-venues-combined.js — that script
// has top-level side effects (auto-runs the full pipeline), so we can't
// `require()` it cleanly. Keep the two copies in sync if you tweak either.

require("dotenv").config();
const mongoose = require("mongoose");
const puppeteer = require("puppeteer");
const Venue = require("../models/Venue");

const MONGO_URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// The 9 venues that failed during the prior seed run.
const FAILED_SLUGS = [
  "magnolia-by-jade",
  "mlr-convention-centre-j-p-nagar",
  "the-park-bangalore",
  "gokulam-grand-hotel-spa",
  "chairmans-jade-devanahalli",
  "ankit-vista-green-village-resorts-hotels",
  "royalton-leisure-aria",
  "the-quad-club-resort-spa",
  "mantra-the-luxury-wedding-destination",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === scrapeMeragiDetail (mirrors the fixed version in seed-venues-combined.js) ===
async function scrapeMeragiDetail(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // Scoped "Read More" click — within the description section only, so we
    // don't trip FAQ/amenity expanders that the old broad search did.
    try {
      const clicked = await page.evaluate(() => {
        const PERFECT_SETTING_RE = /^\s*a perfect setting for your dream wedding\.?\s*$/i;
        const heading = Array.from(document.querySelectorAll("*")).find((el) =>
          PERFECT_SETTING_RE.test((el.innerText || el.textContent || "").trim())
        );
        if (!heading) return false;
        let scope = heading.parentElement;
        for (let i = 0; i < 5 && scope; i++) {
          const candidates = Array.from(scope.querySelectorAll("button, a, span, div"));
          const btn = candidates.find((el) =>
            /^\s*read\s*more\s*$/i.test((el.innerText || el.textContent || "").trim())
          );
          if (btn) {
            btn.click();
            return true;
          }
          scope = scope.parentElement;
        }
        return false;
      });
      if (clicked) await sleep(1500);
    } catch (_) { /* ignore */ }

    return await page.evaluate(() => {
      // ---- description (anchored, with empty fallback) ----
      let description = "";
      const PERFECT_SETTING_RE = /^\s*a perfect setting for your dream wedding\.?\s*$/i;
      const heading = Array.from(document.querySelectorAll("*")).find((el) =>
        PERFECT_SETTING_RE.test((el.innerText || el.textContent || "").trim())
      );
      if (heading) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        walker.currentNode = heading;
        let node = walker.nextNode();
        while (node) {
          if (/^H[1-6]$/.test(node.tagName)) break;
          if (node.tagName === "P") {
            const t = (node.innerText || "").trim();
            if (t.length >= 80 && t.length < 3000) {
              description = t;
              break;
            }
          }
          node = walker.nextNode();
        }
      }

      const bodyText = document.body.innerText || "";

      const photos = Array.from(document.querySelectorAll("img"))
        .map((img) => img.src || img.getAttribute("data-src") || "")
        .filter((u) => u && u.includes("d1p55htxo8z8mf.cloudfront.net"));
      const uniquePhotos = Array.from(new Set(photos));

      const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
      const findValue = (labelRe) => {
        for (let i = 0; i < lines.length; i++) {
          if (labelRe.test(lines[i])) {
            const inline = lines[i].split(/:/).slice(1).join(":").trim();
            if (inline) return inline;
            for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
              if (lines[j] && !/^[A-Z][a-z]+:?$/.test(lines[j])) return lines[j];
            }
          }
        }
        return "";
      };

      const cateringPolicy = findValue(/catering\s*policy|food\s*policy/i);
      const alcoholPolicy = findValue(/alcohol\s*policy|liquor\s*policy/i);

      let paxWithExtraBed = 0;
      let paxWithoutExtraBed = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/with\s*extra\s*bed/i.test(lines[i])) {
          const m = lines[i].match(/\d+/);
          if (m) paxWithExtraBed = parseInt(m[0], 10);
          else if (lines[i + 1]) {
            const m2 = lines[i + 1].match(/\d+/);
            if (m2) paxWithExtraBed = parseInt(m2[0], 10);
          }
        }
        if (/without\s*extra\s*bed/i.test(lines[i])) {
          const m = lines[i].match(/\d+/);
          if (m) paxWithoutExtraBed = parseInt(m[0], 10);
          else if (lines[i + 1]) {
            const m2 = lines[i + 1].match(/\d+/);
            if (m2) paxWithoutExtraBed = parseInt(m2[0], 10);
          }
        }
      }

      return {
        description,
        photos: uniquePhotos,
        cateringPolicy,
        alcoholPolicy,
        paxWithExtraBed,
        paxWithoutExtraBed,
      };
    });
  } finally {
    await page.close();
  }
}

// Map raw scraped text → schema enum values. Same logic the seed pipeline uses
// at PHASE F (saveToMongo), kept inline here so this script stays self-contained.
function parseCateringType(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/in[\s-]?house\s*only/.test(t)) return "in_house_only";
  if (/outside\s*allowed|outside catering/.test(t)) return "outside_allowed";
  if (/both/.test(t)) return "both";
  return null;
}

function parseOutsideAlcohol(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/not\s*allowed|prohibited|no\s*alcohol/.test(t)) return "no";
  if (/extra\s*charge|corkage/.test(t)) return "extra_charge";
  if (/allowed|yes/.test(t)) return "yes";
  return null;
}

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Rescraping ${FAILED_SLUGS.length} Meragi venues.\n`);

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  let updatedCount = 0;
  const failures = [];

  try {
    for (let idx = 0; idx < FAILED_SLUGS.length; idx++) {
      const slug = FAILED_SLUGS[idx];
      const tag = `[${idx + 1}/${FAILED_SLUGS.length}] ${slug}`;
      console.log(tag);

      const venue = await Venue.findOne({ slug }).select("_id slug name photos").lean();
      if (!venue) {
        console.warn(`  ⚠  not in DB — skipping`);
        failures.push({ slug, error: "not in DB" });
        continue;
      }

      const url = `https://www.meragi.com/venue-blog/${slug}/`;
      console.log(`  → ${url}`);

      let detail;
      try {
        detail = await scrapeMeragiDetail(browser, url);
      } catch (err) {
        console.warn(`  ✗ scrape failed: ${err.message}`);
        failures.push({ slug, error: err.message });
        await sleep(2000);
        continue;
      }

      const update = {};
      const wrote = [];

      if (detail.description) {
        update.description = detail.description;
        wrote.push(`description (${detail.description.length} chars)`);
      }

      if (Array.isArray(detail.photos) && detail.photos.length > 0) {
        const existing = Array.isArray(venue.photos?.venue) ? venue.photos.venue : [];
        const merged = Array.from(new Set([...detail.photos, ...existing]));
        update["photos.venue"] = merged;
        wrote.push(`photos.venue (${detail.photos.length} new, ${merged.length} total)`);
      }

      const cateringType = parseCateringType(detail.cateringPolicy);
      if (cateringType) {
        update["cateringPolicy.type"] = cateringType;
        wrote.push(`cateringPolicy.type=${cateringType}`);
      }

      const alcoholVal = parseOutsideAlcohol(detail.alcoholPolicy);
      if (alcoholVal) {
        update["amenities.outsideAlcohol"] = alcoholVal;
        wrote.push(`amenities.outsideAlcohol=${alcoholVal}`);
      }

      const pax = detail.paxWithExtraBed || detail.paxWithoutExtraBed || 0;
      if (pax > 0) {
        update["accommodation.available"] = true;
        update["accommodation.totalCapacity"] = pax;
        wrote.push(`accommodation.totalCapacity=${pax}`);
      }

      if (Object.keys(update).length === 0) {
        console.warn(`  ✗ no extractable fields — Meragi page may be unreachable or empty`);
        failures.push({ slug, error: "no data extracted" });
        await sleep(2000);
        continue;
      }

      await Venue.updateOne({ _id: venue._id }, { $set: update });
      console.log(`  ✓ updated: ${wrote.join(", ")}`);
      updatedCount++;

      // Be polite — give Meragi a breather between detail loads.
      await sleep(2000);
    }
  } finally {
    await browser.close();
    await mongoose.disconnect();
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated:  ${updatedCount} / ${FAILED_SLUGS.length}`);
  console.log(`Failures: ${failures.length}`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  - ${f.slug}: ${f.error}`));
  }
})().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});

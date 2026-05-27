/* eslint-disable no-console */
require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");
const puppeteer = require("puppeteer");
const Anthropic = require("@anthropic-ai/sdk");

const Venue = require("../models/Venue");

const MONGO_URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!MONGO_URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

// ============================================================================
// Constants
// ============================================================================

const WMG_URLS = [
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Resort", category: "Resort" },
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Farm+House", category: "Farm House" },
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Hotels", category: "Hotels" },
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Clubs+%26+Resorts", category: "Clubs & Resorts" },
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Heritage+Venues", category: "Heritage Venues" },
  { url: "https://www.wedmegood.com/search/?item_type=Venues&city=Bangalore&cat=Outdoor+Venues", category: "Outdoor Venues" },
];

const MERAGI_LIST_URL = "https://www.meragi.com/venue-catalogue/bangalore/";

const HOTEL_CHAINS = [
  "taj", "itc", "marriott", "radisson", "sheraton", "leela", "oberoi",
  "hyatt", "hilton", "jw ", "westin", "novotel", "holiday inn", "courtyard",
  "vivanta", "trident",
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function generateSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function classifyVenueType(name, description) {
  const text = (name + " " + (description || "")).toLowerCase();
  if (HOTEL_CHAINS.some((h) => text.includes(h))) return "hotel";
  if (/banquet|convention centre|function hall/.test(text)) return "banquet_hall";
  if (/\bclub\b|golf/.test(text)) return "club";
  if (/farmhouse|farm house/.test(text)) return "farmhouse";
  if (/\bvilla\b/.test(text)) return "villa";
  if (/heritage|palace|haveli/.test(text)) return "heritage";
  return "resort";
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === 0) continue;
    if (v && (typeof v !== "string" || v.trim() !== "")) return v;
  }
  return undefined;
}

function computeDataCompleteness(v) {
  let score = 0;
  if (v.name) score++;
  if (v.address) score++;
  if (v.coverPhoto) score++;
  if (v.description && v.description.length > 60) score++;
  if (Array.isArray(v.photos?.venue) && v.photos.venue.length > 0) score++;
  if (v.contact?.primaryPhone || v.phone) score++;
  if (v.contact?.website || v.website) score++;
  if (v.location?.coordinates?.length === 2) score++;
  if (Array.isArray(v.spaces) && v.spaces.length > 0) score++;
  if (v.accommodation?.totalCapacity > 0) score++;
  return score;
}

function uniquePush(arr, val) {
  if (!val) return arr;
  if (!arr.includes(val)) arr.push(val);
  return arr;
}

// ============================================================================
// PHASE A — Scrape WedMeGood
// ============================================================================

async function scrapeWedMeGood(browser) {
  console.log("\n=== PHASE A: WedMeGood ===");
  const out = [];
  const seen = new Set();

  for (const { url, category } of WMG_URLS) {
    console.log(`\n[WMG] ${category}: ${url}`);
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      // Allow lazy content / pagination links to render.
      await sleep(2500);

      // Scroll to trigger lazy-loaded cards; also tries to expose pagination.
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await sleep(800);
      }

      let pageNum = 1;
      while (true) {
        const cards = await page.evaluate(() => {
          const results = [];
          // Best-guess: WedMeGood listing cards are anchors that point to /vendors/profile/ or /venues/profile/.
          const anchors = Array.from(document.querySelectorAll('a[href*="/vendors/"], a[href*="/venues/"], a[href*="/profile/"]'));
          const seenHrefs = new Set();
          for (const a of anchors) {
            const href = a.href;
            if (!href || seenHrefs.has(href)) continue;
            seenHrefs.add(href);

            // Walk up to the card wrapper.
            const card = a.closest('[class*="card"], [class*="listing"], [class*="vendor"], li, article, div');
            if (!card) continue;
            const text = card.innerText || "";

            // Pull a name from heading or anchor text.
            const headingEl = card.querySelector("h1,h2,h3,h4,h5");
            const name = (headingEl?.innerText || a.innerText || "").trim().split("\n")[0];
            if (!name || name.length < 3) continue;
            if (/^\s*(page|next|prev|view all)\s*$/i.test(name)) continue;

            // Address: short line containing "Bangalore" or "Bengaluru".
            const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
            const address = lines.find((l) => /bangalore|bengaluru/i.test(l) && l.length < 140) || "";

            // Cover image — first <img> with src or data-src.
            const imgEl = card.querySelector("img");
            let cover = "";
            if (imgEl) {
              cover = imgEl.src || imgEl.getAttribute("data-src") || imgEl.getAttribute("data-original") || "";
              const srcset = imgEl.getAttribute("srcset");
              if (!cover && srcset) cover = srcset.split(",")[0].trim().split(" ")[0];
            }

            // Capacity: lines like "100 - 500 pax" or "Up to 500 guests".
            const capLine = lines.find((l) => /pax|guests|capacity/i.test(l));
            let capacityMin = 0;
            let capacityMax = 0;
            if (capLine) {
              const nums = capLine.match(/\d+/g);
              if (nums && nums.length >= 2) {
                capacityMin = parseInt(nums[0], 10);
                capacityMax = parseInt(nums[1], 10);
              } else if (nums && nums.length === 1) {
                capacityMax = parseInt(nums[0], 10);
              }
            }

            // Description snippet — longest line that isn't the name/address/capacity.
            const desc = lines
              .filter((l) => l !== name && l !== address && l !== capLine)
              .sort((a, b) => b.length - a.length)[0] || "";

            results.push({ name, address, coverPhoto: cover, capacityMin, capacityMax, descriptionSnippet: desc, detailUrl: href });
          }
          return results;
        });

        let added = 0;
        for (const c of cards) {
          const key = normalizeName(c.name);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push({ ...c, source: "WedMeGood", category });
          added++;
        }
        console.log(`  page ${pageNum}: +${added} (total ${out.length})`);

        // Try to click a "Next" pagination control.
        const advanced = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll("a, button"));
          const next = candidates.find((el) => {
            const t = (el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
            return /^next$|^›$|^>$|next page/.test(t) && !el.hasAttribute("disabled");
          });
          if (next) {
            next.scrollIntoView();
            next.click();
            return true;
          }
          return false;
        });

        if (!advanced) break;
        await sleep(2500);
        pageNum++;
        if (pageNum > 30) break; // safety
      }
    } catch (err) {
      console.warn(`[WMG] error on ${category}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  console.log(`[WMG] total unique venues: ${out.length}`);
  return out;
}

// ============================================================================
// PHASE B — Scrape Meragi
// ============================================================================

async function scrapeMeragi(browser) {
  console.log("\n=== PHASE B: Meragi ===");
  const out = [];
  const listPage = await browser.newPage();
  await listPage.setUserAgent(UA);

  let cards = [];
  try {
    await listPage.goto(MERAGI_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2500);

    // Scroll until the list stops growing (infinite scroll OR fixed list).
    let last = 0;
    let stableTicks = 0;
    for (let i = 0; i < 40; i++) {
      await listPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1200);
      const count = await listPage.evaluate(() => document.querySelectorAll('a[href*="/venue-blog/"]').length);
      if (count === last) {
        stableTicks++;
        if (stableTicks >= 3) break;
      } else {
        stableTicks = 0;
        last = count;
      }
    }

    cards = await listPage.evaluate(() => {
      const out = [];
      const anchors = Array.from(document.querySelectorAll('a[href*="/venue-blog/"]'));
      const seen = new Set();
      for (const a of anchors) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);

        const card = a.closest('[class*="card"], [class*="venue"], li, article, div') || a;
        const text = card.innerText || "";
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        const headingEl = card.querySelector("h1,h2,h3,h4,h5");
        const name = (headingEl?.innerText || a.innerText || "").trim().split("\n")[0];
        if (!name || name.length < 3) continue;

        const address = lines.find((l) => /bangalore|bengaluru|karnataka/i.test(l) && l.length < 160) || "";

        const imgEl = card.querySelector("img");
        let cover = "";
        if (imgEl) {
          cover = imgEl.src || imgEl.getAttribute("data-src") || imgEl.getAttribute("data-original") || "";
          const srcset = imgEl.getAttribute("srcset");
          if (!cover && srcset) cover = srcset.split(",")[0].trim().split(" ")[0];
        }

        // Meragi card chips: "PAX 500", "Rooms 50", "Spaces 3"
        const numFor = (re) => {
          const ln = lines.find((l) => re.test(l));
          if (!ln) return 0;
          const m = ln.match(/\d+/);
          return m ? parseInt(m[0], 10) : 0;
        };
        const capacity = numFor(/pax|capacity|guests/i);
        const rooms = numFor(/rooms?/i);
        const spaces = numFor(/spaces?/i);

        out.push({ name, address, coverPhoto: cover, capacity, rooms, spacesCount: spaces, detailUrl: href });
      }
      return out;
    });

    console.log(`[Meragi] listing cards found: ${cards.length}`);
  } catch (err) {
    console.warn(`[Meragi] listing error: ${err.message}`);
  } finally {
    await listPage.close();
  }

  // Visit each detail page.
  let i = 0;
  for (const card of cards) {
    i++;
    try {
      const detail = await scrapeMeragiDetail(browser, card.detailUrl);
      out.push({ ...card, ...detail, source: "Meragi" });
    } catch (err) {
      console.warn(`[Meragi] detail error on ${card.detailUrl}: ${err.message}`);
      out.push({ ...card, source: "Meragi" });
    }
    if (i % 10 === 0) console.log(`[Meragi] processed ${i}/${cards.length} detail pages`);
  }

  console.log(`[Meragi] total: ${out.length}`);
  return out;
}

async function scrapeMeragiDetail(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // Try clicking "Read More" within the description section so the full
    // paragraph renders. Scoped to the "A perfect setting…" anchor — the old
    // page-wide search clicked unrelated Read More buttons (FAQ, amenities)
    // and the description it then captured was the whole page.
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
      // ---- description (anchored to "A perfect setting for your dream wedding.") ----
      // Meragi has no "About" heading — the description sits right after this
      // specific marquee line. Walk forward in document order from that
      // element until the next heading, taking the first substantial <p>.
      // Returning "" when the anchor isn't found is by design: better empty
      // than the entire page text leaking in.
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

      // ---- photos from CloudFront CDN ----
      const photos = Array.from(document.querySelectorAll("img"))
        .map((img) => img.src || img.getAttribute("data-src") || "")
        .filter((u) => u && u.includes("d1p55htxo8z8mf.cloudfront.net"));
      const uniquePhotos = Array.from(new Set(photos));

      // ---- field extractor: "Label: Value" or "Label\nValue" patterns ----
      const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
      const findValue = (labelRe) => {
        for (let i = 0; i < lines.length; i++) {
          if (labelRe.test(lines[i])) {
            const inline = lines[i].split(/:/).slice(1).join(":").trim();
            if (inline) return inline;
            // next non-empty line
            for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
              if (lines[j] && !/^[A-Z][a-z]+:?$/.test(lines[j])) return lines[j];
            }
          }
        }
        return "";
      };

      const cateringPolicy = findValue(/catering\s*policy|food\s*policy/i);
      const alcoholPolicy = findValue(/alcohol\s*policy|liquor\s*policy/i);
      const vibeTags = findValue(/vibe\s*in\s*words|vibe/i);

      // Accommodation PAX (with / without extra bed)
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

      // Distance from airport
      let distanceFromAirportKm = 0;
      const distLine = lines.find((l) => /distance.*airport|airport.*km/i.test(l));
      if (distLine) {
        const m = distLine.match(/(\d+(?:\.\d+)?)\s*km/i);
        if (m) distanceFromAirportKm = parseFloat(m[1]);
      }

      // Spaces (name + photos) — best-effort: look for blocks under a "Spaces" heading
      const spaces = [];
      const spacesHeading = Array.from(document.querySelectorAll("h1,h2,h3,h4")).find((h) =>
        /^\s*spaces?\s*$/i.test(h.innerText || "")
      );
      if (spacesHeading) {
        let node = spacesHeading.nextElementSibling;
        let safety = 0;
        while (node && !/^h[1-3]$/i.test(node.tagName) && safety < 40) {
          const sub = node.querySelectorAll("h3,h4,h5");
          sub.forEach((s) => {
            const name = (s.innerText || "").trim();
            if (!name || name.length < 2) return;
            const container = s.closest("div") || s.parentElement;
            const photos = Array.from(container?.querySelectorAll("img") || [])
              .map((i) => i.src || i.getAttribute("data-src") || "")
              .filter((u) => u && u.includes("d1p55htxo8z8mf.cloudfront.net"));
            spaces.push({ name, photos: Array.from(new Set(photos)) });
          });
          node = node.nextElementSibling;
          safety++;
        }
      }

      // Amenities under "Why we love this venue"
      let amenities = [];
      const whyHeading = Array.from(document.querySelectorAll("h1,h2,h3,h4")).find((h) =>
        /why\s*we\s*love/i.test(h.innerText || "")
      );
      if (whyHeading) {
        let node = whyHeading.nextElementSibling;
        let safety = 0;
        const collected = [];
        while (node && !/^h[1-3]$/i.test(node.tagName) && safety < 20) {
          const items = node.querySelectorAll("li, p, span");
          items.forEach((it) => {
            const t = (it.innerText || "").trim();
            if (t && t.length < 80 && t.length > 2) collected.push(t);
          });
          node = node.nextElementSibling;
          safety++;
        }
        amenities = Array.from(new Set(collected));
      }

      return {
        description,
        photos: uniquePhotos,
        cateringPolicy,
        alcoholPolicy,
        paxWithExtraBed,
        paxWithoutExtraBed,
        vibeTags,
        distanceFromAirportKm,
        spaces,
        amenities,
      };
    });
  } finally {
    await page.close();
  }
}

// ============================================================================
// PHASE C — Merge & Deduplicate
// ============================================================================

function mergeVenues(wmg, meragi, existingByKey) {
  console.log("\n=== PHASE C: Merge ===");
  const merged = new Map(); // normName -> venue

  // Seed with existing DB venues so we know which fields are already populated.
  for (const [key, existing] of existingByKey.entries()) {
    merged.set(key, {
      _existing: existing,
      sources: new Set(existing.scrapedFrom || []),
      name: existing.name,
      address: existing.address || "",
      coverPhoto: existing.coverPhoto || "",
      description: existing.description || "",
      photos: Array.isArray(existing.photos?.venue) ? [...existing.photos.venue] : [],
      capacity: existing.spaces?.[0]?.capacitySeated || 0,
      rooms: existing.accommodation?.roomTypes?.[0]?.count || 0,
      spacesCount: Array.isArray(existing.spaces) ? existing.spaces.length : 0,
    });
  }

  // WedMeGood pass — fills gaps but does not overwrite Meragi.
  for (const v of wmg) {
    const key = normalizeName(v.name);
    if (!key) continue;
    const m = merged.get(key) || {};
    m.sources = m.sources || new Set();
    m.sources.add("WedMeGood");
    m.name = pickFirstNonEmpty(m.name, v.name);
    m.address = pickFirstNonEmpty(m.address, v.address);
    m.coverPhoto = pickFirstNonEmpty(m.coverPhoto, v.coverPhoto);
    m.description = pickFirstNonEmpty(m.description, v.descriptionSnippet);
    m.capacity = pickFirstNonEmpty(m.capacity, v.capacityMax || v.capacityMin);
    m.wmgCategory = v.category;
    m.wmgDetailUrl = v.detailUrl;
    merged.set(key, m);
  }

  // Meragi pass — wins on description, photos, capacity, rooms, policies, vibe, etc.
  for (const v of meragi) {
    const key = normalizeName(v.name);
    if (!key) continue;
    const m = merged.get(key) || {};
    m.sources = m.sources || new Set();
    m.sources.add("Meragi");
    // Meragi-priority fields:
    m.name = v.name || m.name;
    m.address = v.address || m.address || "";
    m.coverPhoto = v.coverPhoto || m.coverPhoto || "";
    if (v.description) m.description = v.description;
    if (Array.isArray(v.photos) && v.photos.length) {
      // Meragi first, then any previously seen photos.
      const prev = Array.isArray(m.photos) ? m.photos : [];
      m.photos = Array.from(new Set([...v.photos, ...prev]));
    }
    if (v.capacity) m.capacity = v.capacity;
    if (v.rooms) m.rooms = v.rooms;
    if (v.spacesCount) m.spacesCount = v.spacesCount;
    if (v.cateringPolicy) m.cateringPolicyText = v.cateringPolicy;
    if (v.alcoholPolicy) m.alcoholPolicyText = v.alcoholPolicy;
    if (v.vibeTags) m.vibeTags = v.vibeTags;
    if (v.paxWithExtraBed) m.paxWithExtraBed = v.paxWithExtraBed;
    if (v.paxWithoutExtraBed) m.paxWithoutExtraBed = v.paxWithoutExtraBed;
    if (v.distanceFromAirportKm) m.distanceFromAirportKm = v.distanceFromAirportKm;
    if (Array.isArray(v.spaces) && v.spaces.length) m.meragiSpaces = v.spaces;
    if (Array.isArray(v.amenities) && v.amenities.length) m.amenityList = v.amenities;
    m.meragiDetailUrl = v.detailUrl;
    merged.set(key, m);
  }

  const arr = Array.from(merged.values()).map((v) => ({
    ...v,
    sources: Array.from(v.sources || []),
  }));
  console.log(`[Merge] total merged venues: ${arr.length}`);
  return arr;
}

// ============================================================================
// PHASE B.5 — Anthropic description generation
// ============================================================================

async function generateMissingDescriptions(venues) {
  console.log("\n=== PHASE B.5: Anthropic description fill ===");
  if (!ANTHROPIC_API_KEY) {
    console.log("[Anthropic] no ANTHROPIC_API_KEY set — skipping.");
    return;
  }
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const targets = venues.filter((v) => !v.description || v.description.length < 60);
  console.log(`[Anthropic] generating ${targets.length} descriptions`);

  const systemPrompt =
    "You write factual, vendor-neutral 2-3 sentence descriptions for wedding venues in Bangalore. " +
    "Do not invent specific facts (capacity, prices, awards). Mention the venue type and what makes it suitable for weddings. " +
    "No marketing fluff, no exclamation marks.";

  let i = 0;
  for (const v of targets) {
    i++;
    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: `Venue: ${v.name}\nAddress: ${v.address || "Bangalore"}\nType hint: ${classifyVenueType(v.name, v.description)}`,
          },
        ],
      });
      const text = resp.content?.[0]?.text?.trim();
      if (text) v.description = text;
    } catch (err) {
      console.warn(`[Anthropic] failed for ${v.name}: ${err.message}`);
    }
    if (i % 10 === 0) console.log(`[Anthropic] ${i}/${targets.length}`);
  }
}

// ============================================================================
// PHASE D — Classify
// ============================================================================

function classifyAll(venues) {
  console.log("\n=== PHASE D: Classify ===");
  for (const v of venues) v.venueType = classifyVenueType(v.name, v.description);
  const counts = venues.reduce((acc, v) => ((acc[v.venueType] = (acc[v.venueType] || 0) + 1), acc), {});
  console.log(`[Classify] ${JSON.stringify(counts)}`);
}

// ============================================================================
// PHASE E — Google Places enrichment
// ============================================================================

async function enrichWithGooglePlaces(venues) {
  console.log("\n=== PHASE E: Google Places ===");
  if (!GOOGLE_PLACES_API_KEY) {
    console.log("[Places] no GOOGLE_PLACES_API_KEY — skipping");
    return;
  }

  // Prioritise missing coords first.
  venues.sort((a, b) => {
    const aMissing = !(a._existing?.location?.coordinates?.length === 2);
    const bMissing = !(b._existing?.location?.coordinates?.length === 2);
    return (bMissing ? 1 : 0) - (aMissing ? 1 : 0);
  });

  let i = 0;
  for (const v of venues) {
    i++;
    try {
      const input = `${v.name} Bangalore`;
      const url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";
      const { data } = await axios.get(url, {
        params: {
          input,
          inputtype: "textquery",
          fields: "geometry,formatted_phone_number,website,rating,user_ratings_total,place_id",
          key: GOOGLE_PLACES_API_KEY,
        },
        timeout: 15000,
      });

      const c = data?.candidates?.[0];
      if (c) {
        const lng = c.geometry?.location?.lng;
        const lat = c.geometry?.location?.lat;
        if (typeof lng === "number" && typeof lat === "number") {
          v.location = { type: "Point", coordinates: [lng, lat] };
        }
        v.phone = c.formatted_phone_number || v.phone || "";
        v.website = c.website || v.website || "";
        v.googlePlaceId = c.place_id || v.googlePlaceId || "";
        v.googleRating = typeof c.rating === "number" ? c.rating : v.googleRating;
        v.googleReviewCount = typeof c.user_ratings_total === "number" ? c.user_ratings_total : v.googleReviewCount;
      }
    } catch (err) {
      console.warn(`[Places] ${v.name}: ${err.message}`);
    }
    await sleep(200);
    if (i % 10 === 0) console.log(`[Places] ${i}/${venues.length}`);
  }
}

// ============================================================================
// PHASE F — Save to MongoDB
// ============================================================================

async function saveToMongo(venues) {
  console.log("\n=== PHASE F: Save to MongoDB ===");
  let created = 0;
  let updated = 0;
  let published = 0;
  let i = 0;

  for (const v of venues) {
    i++;
    try {
      const existing = v._existing;
      const baseSlug = generateSlug(v.name);
      const slug = existing?.slug || baseSlug || `venue-${Date.now()}-${i}`;

      const doc = {
        name: v.name,
        slug,
        venueType: v.venueType || "resort",
        city: "Bangalore",
        address: v.address || existing?.address || "",
        description: v.description || existing?.description || "",
        coverPhoto: v.coverPhoto || existing?.coverPhoto || "",
        photos: {
          venue: Array.from(new Set([...(v.photos || []), ...(existing?.photos?.venue || [])])),
          decor: existing?.photos?.decor || [],
          rooms: existing?.photos?.rooms || [],
          spaces: existing?.photos?.spaces || [],
        },
        scrapedFrom: Array.from(new Set([...(existing?.scrapedFrom || []), ...(v.sources || [])])),
      };

      // Location — Google Places overrides everything when present.
      if (v.location?.coordinates?.length === 2) {
        doc.location = v.location;
      } else if (existing?.location?.coordinates?.length === 2) {
        doc.location = existing.location;
      }

      if (v.phone) doc.phone = v.phone;
      if (v.website) doc.website = v.website;
      if (v.googlePlaceId) doc.googlePlaceId = v.googlePlaceId;
      if (typeof v.googleRating === "number") doc.googleRating = v.googleRating;
      if (typeof v.googleReviewCount === "number") doc.googleReviewCount = v.googleReviewCount;

      // Capacity → spaces[0].
      if (v.capacity || (Array.isArray(v.meragiSpaces) && v.meragiSpaces.length)) {
        const spaces = [];
        if (Array.isArray(v.meragiSpaces) && v.meragiSpaces.length) {
          for (const s of v.meragiSpaces) {
            spaces.push({
              name: s.name,
              type: "indoor",
              capacitySeated: v.capacity || 0,
              capacityStanding: 0,
              bestFor: [],
              description: "",
              photos: s.photos || [],
            });
          }
        } else if (v.capacity) {
          spaces.push({
            name: "Main Hall",
            type: "indoor",
            capacitySeated: v.capacity,
            capacityStanding: 0,
            bestFor: [],
            description: "",
            photos: [],
          });
        }
        doc.spaces = spaces;
      }

      // Accommodation.
      if (v.rooms || v.paxWithExtraBed || v.paxWithoutExtraBed) {
        doc.accommodation = {
          available: true,
          totalCapacity: v.paxWithExtraBed || v.paxWithoutExtraBed || 0,
          roomTypes: v.rooms
            ? [{ name: "Standard", count: v.rooms, occupancyPerRoom: 2, maxPeoplePerRoom: 2, pricePerNight: 0, isAC: true, description: "", photos: [] }]
            : [],
        };
      }

      // Catering / alcohol policies.
      if (v.cateringPolicyText) {
        const t = v.cateringPolicyText.toLowerCase();
        let kind = "unknown";
        if (/in[\s-]?house\s*only|in[\s-]?house only/.test(t)) kind = "in_house_only";
        else if (/outside\s*allowed|outside catering/.test(t)) kind = "outside_allowed";
        else if (/both/.test(t)) kind = "both";
        doc.cateringPolicy = { type: kind, outsideKitchenFee: 0, outsideSetupFrom: "", dietaryOptions: [], cuisines: [], minPerPlate: 0 };
      }
      if (v.alcoholPolicyText) {
        const t = v.alcoholPolicyText.toLowerCase();
        let outsideAlcohol = "no";
        if (/allowed|yes/.test(t) && !/not\s*allowed/.test(t)) outsideAlcohol = "yes";
        else if (/extra\s*charge|corkage/.test(t)) outsideAlcohol = "extra_charge";
        doc.amenities = { ...(existing?.amenities || {}), outsideAlcohol };
      }

      // Vibe tags + amenities text — store as seoKeywords for now (no schema field).
      const keywords = new Set(existing?.seoKeywords || []);
      if (v.vibeTags) v.vibeTags.split(/[,;|]/).forEach((t) => keywords.add(t.trim()));
      if (Array.isArray(v.amenityList)) v.amenityList.forEach((t) => keywords.add(t.trim()));
      if (keywords.size) doc.seoKeywords = Array.from(keywords).filter(Boolean).slice(0, 50);

      // Distance from airport → locationDescription.
      if (v.distanceFromAirportKm) {
        doc.locationDescription = `${v.distanceFromAirportKm} km from Kempegowda International Airport`;
      }

      doc.dataCompleteness = computeDataCompleteness({ ...existing, ...doc });

      // Auto-publish rule.
      const hasMeragi = (v.sources || []).includes("Meragi");
      const canPublish =
        doc.name && doc.address && doc.coverPhoto && (doc.dataCompleteness >= 5 || hasMeragi);
      if (canPublish && (!existing || existing.status === "draft")) {
        doc.status = "published";
        published++;
      }

      if (existing) {
        await Venue.updateOne({ _id: existing._id }, { $set: doc });
        updated++;
      } else {
        // Avoid duplicate slug on insert.
        let finalSlug = slug;
        let n = 1;
        // eslint-disable-next-line no-await-in-loop
        while (await Venue.exists({ slug: finalSlug })) {
          finalSlug = `${slug}-${n++}`;
          if (n > 50) {
            finalSlug = `${slug}-${Date.now()}`;
            break;
          }
        }
        doc.slug = finalSlug;
        await Venue.create(doc);
        created++;
      }
    } catch (err) {
      console.warn(`[Save] ${v.name}: ${err.message}`);
    }
    if (i % 10 === 0) console.log(`[Save] ${i}/${venues.length} (created ${created}, updated ${updated})`);
  }

  return { created, updated, published };
}

// ============================================================================
// PHASE G — Report
// ============================================================================

async function report(result) {
  console.log("\n=== PHASE G: Report ===");
  const total = await Venue.countDocuments({});
  const bySource = await Venue.aggregate([
    { $unwind: { path: "$scrapedFrom", preserveNullAndEmptyArrays: true } },
    { $group: { _id: "$scrapedFrom", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const byType = await Venue.aggregate([
    { $group: { _id: "$venueType", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`Total venues in DB:    ${total}`);
  console.log(`New venues added:      ${result.created}`);
  console.log(`Existing updated:      ${result.updated}`);
  console.log(`Venues published:      ${result.published}`);
  console.log("\nBy source:");
  bySource.forEach((r) => console.log(`  ${r._id ?? "(none)"}: ${r.count}`));
  console.log("\nBy type:");
  byType.forEach((r) => console.log(`  ${r._id ?? "(none)"}: ${r.count}`));
}

// ============================================================================
// Main
// ============================================================================

async function loadExistingByNormalizedName() {
  const all = await Venue.find({}).lean();
  const map = new Map();
  for (const v of all) {
    const key = normalizeName(v.name);
    if (key) map.set(key, v);
  }
  return map;
}

(async () => {
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("Connected.");

  const existingByKey = await loadExistingByNormalizedName();
  console.log(`Existing venues in DB: ${existingByKey.size}`);

  console.log("Launching Puppeteer…");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  try {
    const wmg = await scrapeWedMeGood(browser);
    const meragi = await scrapeMeragi(browser);
    const merged = mergeVenues(wmg, meragi, existingByKey);
    await generateMissingDescriptions(merged);
    classifyAll(merged);
    await enrichWithGooglePlaces(merged);
    const result = await saveToMongo(merged);
    await report(result);
  } finally {
    await browser.close();
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});

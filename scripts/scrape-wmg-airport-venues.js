/* eslint-disable no-console */
require("dotenv").config();
const mongoose = require("mongoose");
const puppeteer = require("puppeteer");

const Venue = require("../models/Venue");

const MONGO_URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

const LISTING_URL = "https://www.wedmegood.com/vendors/bangalore/wedding-venues/near-bangalore-airport";
const DIRECT_DETAIL_URLS = [
  "https://www.wedmegood.com/wedding-venues/Crown-Estate-25860475",
  "https://www.wedmegood.com/wedding-venues/ritam--the-wedding-venue--24885789",
];

const HOTEL_CHAINS = [
  "taj", "itc", "marriott", "radisson", "sheraton", "leela", "oberoi",
  "hyatt", "hilton", "westin", "novotel", "holiday inn", "courtyard",
  "vivanta", "trident",
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (/banquet|hall|convention/.test(text)) return "banquet_hall";
  if (/\bclub\b|golf/.test(text)) return "club";
  if (/farmhouse|farm\b/.test(text)) return "farmhouse";
  return "resort";
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// WMG detail URLs look like /wedding-venues/<slug>-<numeric-id>.
// Derive a human-ish name from that slug as a fallback.
function nameFromDetailUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    const stripped = last.replace(/-\d+$/, "").replace(/-+/g, " ").replace(/\s+/g, " ").trim();
    if (!stripped) return "";
    return stripped
      .split(" ")
      .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  } catch (_) {
    return "";
  }
}

// Names that are clearly nav/category/section headings, not venues.
function isSectionOrCategoryName(name) {
  if (!name) return true;
  const n = name.trim();
  if (n.length < 3 || n.length > 90) return true;
  const low = n.toLowerCase();
  // Category nav labels.
  if (/^(bridal wear|photographers?|mehendi artists?|makeup artists?|wedding planners?|invitations?|jewellery|videographers?|wedding cards?)$/i.test(low)) return true;
  // Listing-page section headings.
  if (/^(wedding venues|best .*for wedding|venues in |top \d+|browse |explore |all venues)/i.test(low)) return true;
  // Trailing count parentheses: "Foo (93)".
  if (/\(\s*\d+\s*\)\s*$/.test(n)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scrape listing — collect cards across all pages
// ---------------------------------------------------------------------------

async function scrapeListing(browser, url) {
  console.log(`\n[listing] ${url}`);
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const all = [];
  const seen = new Set();

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    await sleep(2500);

    // Scroll to trigger lazy-loaded tiles and bring pagination control into view.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(700);
    }

    let pageNum = 1;
    while (true) {
      const cards = await page.evaluate(() => {
        const out = [];
        // WMG venue tiles link to /wedding-venues/<slug>-<numeric-id>.
        const anchors = Array.from(document.querySelectorAll('a[href*="/wedding-venues/"]'));
        const seenHref = new Set();
        for (const a of anchors) {
          const href = a.href;
          if (!href || seenHref.has(href)) continue;
          if (!/\/wedding-venues\/[^/]+-\d+\/?$/i.test(href)) continue; // skip categories / listings
          seenHref.add(href);

          // Tile cover image: nearest <img> inside the tile.
          const tile = a.closest('[class*="card"], [class*="tile"], [class*="vendor"], li, article, div') || a;
          const img = tile.querySelector("img");
          let cover = "";
          if (img) {
            cover =
              img.src ||
              img.getAttribute("data-src") ||
              img.getAttribute("data-original") ||
              "";
            const srcset = img.getAttribute("srcset");
            if (!cover && srcset) cover = srcset.split(",")[0].trim().split(" ")[0];
          }

          // Name: derive from URL slug (anchor text is empty on WMG tiles).
          let name = "";
          try {
            const u = new URL(href);
            const last = u.pathname.split("/").filter(Boolean).pop() || "";
            const stripped = last.replace(/-\d+$/, "").replace(/-+/g, " ").trim();
            if (stripped) {
              name = stripped
                .split(" ")
                .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
                .join(" ");
            }
          } catch (_) { /* ignore */ }
          if (!name) continue;

          // Capacity (if surfaced on the tile).
          const tileText = (tile.innerText || "").trim();
          const lines = tileText.split("\n").map((l) => l.trim()).filter(Boolean);
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
          const address =
            lines.find((l) => /bangalore|bengaluru/i.test(l) && l.length < 140) || "";

          out.push({ name, address, coverPhoto: cover, capacityMin, capacityMax, detailUrl: href });
        }
        return out;
      });

      let added = 0;
      for (const c of cards) {
        if (isSectionOrCategoryName(c.name)) continue;
        const key = normalizeName(c.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(c);
        added++;
      }
      console.log(`  [listing] page ${pageNum}: +${added} (total ${all.length})`);

      const advanced = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("a, button"));
        const next = btns.find((el) => {
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
    console.warn(`[listing] error: ${err.message}`);
  } finally {
    await page.close();
  }

  console.log(`[listing] total unique cards: ${all.length}`);
  return all;
}

// ---------------------------------------------------------------------------
// Scrape one WMG detail page
// ---------------------------------------------------------------------------

async function scrapeDetail(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (resp && (resp.status() === 403 || resp.status() === 429 || resp.status() >= 500)) {
      const blocked = await page.evaluate(() => /cloudflare|error 1015|rate.?limit|attention required/i.test(document.body.innerText || ""));
      if (blocked) return { __blocked: true, status: resp.status() };
    }
    await sleep(1500);
    // Even on a 200, Cloudflare's challenge page can render — sniff body text.
    const blockedBody = await page.evaluate(() => /error 1015|cloudflare ray id|attention required|just a moment\./i.test(document.body.innerText || ""));
    if (blockedBody) return { __blocked: true, status: resp ? resp.status() : 0 };

    // Click any "Read More" / "Show more" toggles so the full description renders.
    try {
      const clicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, a, span, div"));
        let did = false;
        for (const el of els) {
          const t = (el.innerText || "").trim().toLowerCase();
          if (/^(read more|show more|view more)$/.test(t)) {
            el.click();
            did = true;
          }
        }
        return did;
      });
      if (clicked) await sleep(800);
    } catch (_) { /* ignore */ }

    // Small scroll to nudge venue-gallery lazy-loading without scrolling so
    // far that the "Shop Bridal Wear" widget at the bottom kicks in and
    // floods the page with unrelated catalog content.
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(400);
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(400);

    return await page.evaluate(() => {
      // ---- Name ----
      // WMG detail pages have exactly one h1 = the venue name.
      const nameEl = document.querySelector("h1");
      const name = ((nameEl?.innerText || "").trim().split("\n")[0]) || "";

      // ---- Address ----
      // h2 of the form: "About <Name> - Wedding Venues, <area>, Bangalore"
      const aboutH2 = Array.from(document.querySelectorAll("h2")).find((h) =>
        /^about\s+/i.test((h.innerText || "").trim())
      );
      let address = "";
      if (aboutH2) {
        const t = (aboutH2.innerText || "").replace(/\s+/g, " ").trim();
        // Take everything after the first " - " (or the venue name).
        const dashSplit = t.split(/\s-\s/);
        const tail = dashSplit.length > 1 ? dashSplit.slice(1).join(" - ") : t;
        // Trim "Wedding Venues," prefix if present.
        address = tail.replace(/^Wedding Venues,?\s*/i, "").trim();
      }
      if (!address) {
        // Fallback: line in body containing Bangalore/Bengaluru, > 15 chars, that doesn't look nav.
        const allLines = (document.body.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        address = allLines.find(
          (l) =>
            /bangalore|bengaluru/i.test(l) &&
            l.length > 15 &&
            l.length < 200 &&
            !/^(home|venues|vendors|photos|blog|real weddings|near|in|all|wedding planners?)/i.test(l) &&
            !/download app|favourite wedding/i.test(l)
        ) || "";
      }

      // ---- Description ----
      // Strictly: walk siblings of the "About <name>" h2. No greedy fallback —
      // we'd rather return empty than poison existing data with chrome text.
      const BAD_DESC = /download app|favourite wedding planning|write a review|wedmegood is your personal|browse through the site|wedding inspiration|copyright|terms (of|&) (use|service)|privacy policy|all rights reserved|follow us|bridal wear|crop top|lehenga|sherwani|saree by|gown by|amaltas couture|sitara by|wedcommerce|cloudflare|error 1015|rate.?limit/i;
      let description = "";
      if (aboutH2) {
        let chunks = [];
        let sib = aboutH2.nextElementSibling;
        while (sib && !/^h[12]$/i.test(sib.tagName)) {
          const t = (sib.innerText || "").trim();
          if (t && !BAD_DESC.test(t) && t.length < 4000) chunks.push(t);
          sib = sib.nextElementSibling;
        }
        description = chunks.join("\n\n").trim();
      }
      // Final venue-specificity check: require the description to mention either
      // the venue name OR a location word, and exceed a minimum length.
      const venueNameLow = (name || "").toLowerCase();
      const looksVenueSpecific =
        description.length > 80 &&
        (
          (venueNameLow && description.toLowerCase().includes(venueNameLow.split(" ")[0])) ||
          /bangalore|bengaluru|karnataka|venue|wedding/i.test(description)
        ) &&
        !BAD_DESC.test(description);
      if (!looksVenueSpecific) description = "";

      // ---- Photos ----
      // Real venue photos live on image.wedmegood.com under /resized/*X/<digits>/...
      // UI assets are under /resized/*/images/icons/ or /images/<file>.
      // Bridal-wear catalog images live under /wedcommerce/media/catalog/product/.
      const BAD_PHOTO = /\/images\/(icons|logos|svgs|illustrations|wmg-)|badge|logo|sprite|placeholder|app-store|play-store|service-badge|search_icon|write_a_review|download_app|WMG-logo|wmg-|wedcommerce|catalog\/product/i;
      const photos = Array.from(document.querySelectorAll("img"))
        .map((img) => img.src || img.getAttribute("data-src") || img.getAttribute("data-original") || "")
        .filter(
          (u) =>
            u &&
            /^https?:/.test(u) &&
            /\.(jpe?g|png|webp)(\?|$)/i.test(u) &&
            /image\.wedmegood\.com|images\.wedmegood\.com/i.test(u) &&
            !BAD_PHOTO.test(u)
        );
      const uniquePhotos = Array.from(new Set(photos));
      const coverPhoto = uniquePhotos[0] || "";

      // Whole-body lines for downstream field heuristics.
      const lines = (document.body.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);

      // Phone: prefer a tel: link, then a phone-shaped line.
      let phone = "";
      const telLink = document.querySelector('a[href^="tel:"]');
      if (telLink) phone = telLink.getAttribute("href").replace(/^tel:/, "").trim();
      if (!phone) {
        const phoneLine = lines.find((l) => /(\+91|^0?[6-9])\s?\d{4,}/.test(l) && l.length < 40);
        if (phoneLine) {
          const m = phoneLine.match(/\+?\d[\d\s\-]{7,}/);
          if (m) phone = m[0].trim();
        }
      }

      // Per-plate veg / non-veg pricing.
      let priceVeg = 0;
      let priceNonVeg = 0;
      for (const l of lines) {
        const low = l.toLowerCase();
        if (/per\s*plate/.test(low) || /veg.*₹|veg.*rs|veg.*inr/.test(low) || /₹.*veg/.test(low)) {
          if (/non[\s-]?veg/.test(low)) {
            const m = l.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
            if (m) priceNonVeg = parseInt(m[1].replace(/,/g, ""), 10);
          } else if (/veg/.test(low)) {
            const m = l.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
            if (m) priceVeg = parseInt(m[1].replace(/,/g, ""), 10);
          }
        }
      }

      // Rooms count: line like "50 Rooms" or "Rooms: 50".
      let rooms = 0;
      const roomLine = lines.find((l) => /\brooms?\b/i.test(l) && /\d/.test(l) && l.length < 80);
      if (roomLine) {
        const m = roomLine.match(/\d+/);
        if (m) rooms = parseInt(m[0], 10);
      }

      // Capacity.
      let capacityMin = 0;
      let capacityMax = 0;
      const capLine = lines.find((l) => /pax|guests|capacity/i.test(l) && /\d/.test(l));
      if (capLine) {
        const nums = capLine.match(/\d+/g);
        if (nums && nums.length >= 2) {
          capacityMin = parseInt(nums[0], 10);
          capacityMax = parseInt(nums[1], 10);
        } else if (nums && nums.length === 1) {
          capacityMax = parseInt(nums[0], 10);
        }
      }

      // Venue type hint from the page (e.g. "Banquet Hall", "Resort").
      let typeHint = "";
      const typeLine = lines.find((l) =>
        /\b(resort|farmhouse|farm house|banquet|hotel|club|hall|villa|heritage)\b/i.test(l) &&
        l.length < 60
      );
      if (typeLine) typeHint = typeLine;

      return {
        name,
        address,
        description,
        photos: uniquePhotos,
        coverPhoto,
        phone,
        priceVeg,
        priceNonVeg,
        rooms,
        capacityMin,
        capacityMax,
        typeHint,
      };
    });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Upsert into MongoDB
// ---------------------------------------------------------------------------

async function upsertVenue(scraped) {
  const name = scraped.name?.trim();
  if (!name) return { skipped: true };

  // Case-insensitive exact match on name.
  const existing = await Venue.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
  });

  const venueType = classifyVenueType(name, scraped.description || scraped.typeHint || "");

  const doc = {
    name,
    venueType,
    city: "Bangalore",
    address: scraped.address || existing?.address || "",
    description: scraped.description || existing?.description || "",
    coverPhoto: scraped.coverPhoto || existing?.coverPhoto || "",
    phone: scraped.phone || existing?.phone || "",
  };

  // Photos — merge with existing.
  if (Array.isArray(scraped.photos) && scraped.photos.length) {
    doc.photos = {
      venue: Array.from(new Set([...(scraped.photos || []), ...(existing?.photos?.venue || [])])),
      decor: existing?.photos?.decor || [],
      rooms: existing?.photos?.rooms || [],
      spaces: existing?.photos?.spaces || [],
    };
  }

  // Per-plate pricing.
  if (scraped.priceVeg || scraped.priceNonVeg) {
    doc.pricing = {
      ...(existing?.pricing || {}),
      perPlate: {
        veg: scraped.priceVeg || existing?.pricing?.perPlate?.veg || 0,
        nonVeg: scraped.priceNonVeg || existing?.pricing?.perPlate?.nonVeg || 0,
      },
    };
  }

  // Rooms → accommodation.
  if (scraped.rooms) {
    doc.accommodation = {
      available: true,
      totalCapacity: existing?.accommodation?.totalCapacity || 0,
      roomTypes: (existing?.accommodation?.roomTypes?.length)
        ? existing.accommodation.roomTypes
        : [{
            name: "Standard",
            count: scraped.rooms,
            occupancyPerRoom: 2,
            maxPeoplePerRoom: 2,
            pricePerNight: 0,
            isAC: true,
            description: "",
            photos: [],
          }],
    };
  }

  // Capacity → spaces[0].
  if (scraped.capacityMax && (!existing?.spaces || existing.spaces.length === 0)) {
    doc.spaces = [{
      name: "Main Hall",
      type: "indoor",
      capacitySeated: scraped.capacityMax,
      capacityStanding: 0,
      bestFor: [],
      description: "",
      photos: [],
    }];
  }

  // scrapedFrom: add "wedmegood" without duplicates.
  doc.scrapedFrom = Array.from(new Set([...(existing?.scrapedFrom || []), "wedmegood"]));

  if (existing) {
    await Venue.updateOne({ _id: existing._id }, { $set: doc });
    return { updated: true, name };
  }

  // New venue — pick a slug.
  let slug = generateSlug(name) || `venue-${Date.now()}`;
  let n = 1;
  while (await Venue.exists({ slug })) {
    slug = `${generateSlug(name)}-${n++}`;
    if (n > 50) { slug = `${generateSlug(name)}-${Date.now()}`; break; }
  }

  // Auto-publish rule.
  const canPublish = doc.name && doc.address && doc.coverPhoto;
  doc.slug = slug;
  doc.status = canPublish ? "published" : "draft";

  await Venue.create(doc);
  return { created: true, published: canPublish, name };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);

  console.log("Launching Puppeteer…");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  let scraped = 0;
  let created = 0;
  let updated = 0;
  let published = 0;

  try {
    // 1) Listing → detail pages.
    const cards = await scrapeListing(browser, LISTING_URL);

    const detailJobs = [
      ...cards.map((c) => ({ url: c.detailUrl, hint: c })),
      ...DIRECT_DETAIL_URLS.map((u) => ({ url: u, hint: null })),
    ];

    console.log(`\nVisiting ${detailJobs.length} detail page(s)…`);

    let i = 0;
    for (const job of detailJobs) {
      i++;
      try {
        const detail = await scrapeDetail(browser, job.url);

        // Cloudflare or other block: skip without writing anything.
        if (detail && detail.__blocked) {
          console.warn(`  [${i}/${detailJobs.length}] BLOCKED by Cloudflare (status ${detail.status}) on ${job.url} — not writing`);
          // Back off harder before continuing.
          await sleep(5000);
          continue;
        }

        // Name priority: listing card > URL slug > detail page heading.
        // The detail-page heading is unreliable because the first h1/h2 on WMG is
        // a sidebar category label ("Bridal Wear") rather than the venue name.
        let resolvedName = job.hint?.name || nameFromDetailUrl(job.url) || detail.name || "";

        // Refuse to upsert anything that still looks like a nav/category label.
        if (!resolvedName || isSectionOrCategoryName(resolvedName)) {
          console.warn(`  [${i}/${detailJobs.length}] rejected non-venue name "${resolvedName}" for ${job.url} — skipping`);
          continue;
        }

        const merged = {
          name: resolvedName,
          address: detail.address || job.hint?.address || "",
          coverPhoto: detail.coverPhoto || job.hint?.coverPhoto || "",
          description: detail.description || "",
          photos: detail.photos || [],
          phone: detail.phone || "",
          priceVeg: detail.priceVeg || 0,
          priceNonVeg: detail.priceNonVeg || 0,
          rooms: detail.rooms || 0,
          capacityMin: detail.capacityMin || job.hint?.capacityMin || 0,
          capacityMax: detail.capacityMax || job.hint?.capacityMax || 0,
          typeHint: detail.typeHint || "",
        };

        scraped++;
        const res = await upsertVenue(merged);
        if (res.created) {
          created++;
          if (res.published) published++;
          console.log(`  [${i}/${detailJobs.length}] + created${res.published ? " (published)" : " (draft)"}: ${res.name}`);
        } else if (res.updated) {
          updated++;
          console.log(`  [${i}/${detailJobs.length}] ~ updated: ${res.name}`);
        } else {
          console.log(`  [${i}/${detailJobs.length}] · skipped: ${job.url}`);
        }
      } catch (err) {
        console.warn(`  [${i}/${detailJobs.length}] error on ${job.url}: ${err.message}`);
      }
      await sleep(2500);
    }
  } finally {
    await browser.close();
    await mongoose.disconnect();
  }

  console.log("\n=== Summary ===");
  console.log(`Total scraped: ${scraped}`);
  console.log(`New added:     ${created}`);
  console.log(`Updated:       ${updated}`);
  console.log(`Published:     ${published}`);
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

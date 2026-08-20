const mongoose = require("mongoose");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const { suggestProductCode, isCodeTaken } = require("../utils/decorCode");
const { storeRemoteImage, toAnalysisBase64 } = require("../utils/remoteImageToS3");
const { analyseImage } = require("./decorVision");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("./decorPricing");
const { buildListingContext } = require("./decorListingContext");
const sizeLadder = require("./decorSizeLadder");
const { tierOf } = require("./decorPricing");
const { normalizeImageUrl } = require("./decorImageKey");
const { lookupRead, panelQuoteFor } = require("./decorReadCache");

const err = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// ── Dedupe key ───────────────────────────────────────────────────────────────
// pinId wins when the extension supplies one. Otherwise we match on a
// NORMALISED image URL: Pinterest serves the same asset at many sizes
// (/236x/, /564x/, /originals/), so the stable identity is the trailing
// hash path (ab/cd/<hash>.jpg), not the full URL.
//
// The normaliser moved to services/decorImageKey on 2026-08-17 so the demo-price
// read cache could share it instead of growing a second copy that drifts. Still
// re-exported from here — it is part of this module's published surface.
//
// ⚠️ DELIBERATE DIVERGENCE (ruled 2026-08-17): this filter stays
// pinId-first-EITHER-OR, while the read cache $ORs over both keys (see the
// matching note in services/decorReadCache). The asymmetry is intentional and
// follows the cost of being wrong in each direction:
//   • cache — a false NEGATIVE (miss when it should hit) is the exact bug the
//     cache exists to fix, and a false positive costs nothing, so match widely.
//   • dedupe — a false POSITIVE refuses a legitimate A2S click with "already in
//     the store", which a human then has to argue with. Match narrowly.
// So: do NOT "fix" this into an $or to match the cache. They are different
// questions with different failure costs.
const dedupeFilterFor = ({ pinId, normalizedUrl }) =>
  pinId
    ? { "sourceImage.pinId": pinId }
    : { "sourceImage.normalizedUrl": normalizedUrl };

// ─────────────────────────────────────────────────────────────────────────────
// MEASUREMENTS — vision reading → CATALOGUE {length, width, height, area}
//
// THE BUG THIS FIXES (2026-08-20). `suggested.measurements` was
//   analysis.stageMeasurements || analysis.size || {}
// and a stageMeasurements object has backdropWidthFt / floralRunFt / spanWidthFt
// and NO length or width. approveDraft then did `Number(measurements.length) || 0`
// and published a product with ZERO measurements — on every CACHE-HIT draft,
// which are precisely the drafts that carry a panel quote, i.e. the good ones. A
// zero-measurement product is excluded from size-matched pricing for good, so the
// better the draft, the worse the published record. Reordering the `||` would not
// fix it: the demo analysis carries BOTH fields, so `size` would silently win and
// the counted backdrop reading — the reliable one — would be thrown away.
//
// THE MAPPING, and why each axis is what it is:
//   length ← backdropWidthFt, SNAPPED to the nearest ladder rung.
//     backdropWidthFt is count × width-each — the counted number the whole
//     measurement design exists to produce, and the one the prompt calls reliable
//     where eyeballing a span is not. It is snapped because an unsnapped 26ft
//     matches no catalogue bucket and would be excluded from size-matched pricing
//     exactly like a zero would.
//   width  ← that same rung's width. On this ladder width IS a function of
//     length, so taking both from one rung is the only way to get a pair the
//     engine can match. Never mixed from two sources.
//   height ← estimatedHeightFt, already resolved to a real build height
//     (10/12/15) by readStageMeasurements. Passed through, never snapped again.
//   area   ← length × width, computed. Never read from the vision payload.
//
// A catalogue-shaped input (a human's edit, or a cache-miss draft whose analysis
// carried `size`) is passed through untouched — this only rescues the shape that
// has no length/width of its own.
const toCatalogueMeasurements = (m) => {
  const src = m && typeof m === "object" ? m : {};
  const zero = { length: 0, width: 0, height: 0, area: 0, radius: 0, other: "" };

  const L = Number(src.length);
  const W = Number(src.width);
  if (L > 0 && W > 0) {
    return {
      length: L,
      width: W,
      height: Number(src.height) || 0,
      area: Number(src.area) > 0 ? Number(src.area) : L * W,
      radius: Number(src.radius) || 0,
      other: String(src.other || ""),
    };
  }

  const rung = sizeLadder.nearestRung(src.backdropWidthFt);
  if (rung) {
    return {
      length: rung.length,
      width: rung.width,
      height: Number(src.estimatedHeightFt) || 0,
      area: rung.area,
      radius: 0,
      other: String(src.other || ""),
    };
  }
  return zero;
};

// What a draft should PRE-FILL as its measurements. Prefers the counted backdrop
// reading and falls back to the model's snapped size guess.
const measurementsFromAnalysis = (analysis) => {
  const a = analysis || {};
  const fromBackdrop = toCatalogueMeasurements(a.stageMeasurements);
  if (fromBackdrop.length > 0) return fromBackdrop;
  return toCatalogueMeasurements(a.size);
};

const nameOf = async (adminId) => {
  if (!adminId) return "someone";
  const a = await Admin.findById(adminId, { name: 1 }).lean();
  return (a && a.name) || "someone";
};

const onDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "an unknown date";

// ── Category vocabulary helpers, derived from live data ──────────────────────
const TIER_LABEL = {
  artificial: "Artificial Flowers",
  mixed: "Mixed Flowers",
  natural: "Natural Flowers",
  flat: "Price",
};

const unitFor = async (category) => {
  const docs = await Decor.find({ category, unit: { $nin: [null, ""] } }, { unit: 1 }).lean();
  const counts = new Map();
  for (const d of docs) counts.set(d.unit, (counts.get(d.unit) || 0) + 1);
  if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return "Pc";
};

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO BRAINS. One image fetch, two independent analyses, both persisted
// untrimmed. Deliberately NOT fused: different calibration, different failure
// modes, and the pricing path is pinned by 372 tests.
// ─────────────────────────────────────────────────────────────────────────────

// ── The pricing half, split from the vision half (2026-08-17) ────────────────
// Everything below the vision call, given an analysis from ANY source. Split out
// so a cached DEMO read can be priced without paying for a second look at the
// same image.
//
// Why a demo read is a valid input here: postProcess builds one shared `base`
// for every vision mode — { isDecorProduct, category, categoryConfidence, style,
// size, complexity } — and those six fields are the complete set this function
// reads. Demo mode adds observations/measurements/occasion on top; only the
// LISTING copy fields (flowers, colors, fabric, suggestedName, description, tags,
// included) are missing from a demo read, and none of them price anything. That
// is why a cache hit still costs ONE call: the cached read settles the price, and
// the call supplies only the copy it cannot carry.
const priceFromAnalysis = async (analysis) => {
  const out = { analysis, pricing: null, fallbacks: [], rejected: false };
  if (!analysis.isDecorProduct) {
    out.rejected = true;
    return out;
  }

  const cat = analysis.category;
  const applicable = CATEGORY_TIERS[cat];

  // Same confidence gates the draft path already uses (env-overridable).
  const CATEGORY_CONF_MIN = Number(process.env.DECOR_VISION_CATEGORY_CONF_MIN) || 0.5;
  const SIZE_CONF_MIN = Number(process.env.DECOR_VISION_SIZE_CONF_MIN) || 0.5;
  const COMPLEXITY_CONF_MIN = Number(process.env.DECOR_VISION_COMPLEXITY_CONF_MIN) || 0.5;

  if (analysis.categoryConfidence < CATEGORY_CONF_MIN) {
    out.fallbacks.push(`category: low confidence (${analysis.categoryConfidence})`);
  }
  const sizeConf = analysis.size ? analysis.size.confidence : 0;
  const sizeIsSized = cat === "Stage" || cat === "Mandap";
  const useSize = sizeIsSized && sizeConf >= SIZE_CONF_MIN;
  if (sizeIsSized && !useSize) {
    out.fallbacks.push(`size: low confidence (${sizeConf}) — ignored, using the category band (median)`);
  }
  const cxConf = analysis.complexity ? analysis.complexity.confidence : 0;
  const useComplexity = cxConf >= COMPLEXITY_CONF_MIN;
  const complexityTier = useComplexity ? analysis.complexity.tier : "standard";
  if (!useComplexity) {
    out.fallbacks.push(`complexity: low confidence (${cxConf}) — defaulted to standard (median)`);
  }
  // ── STYLE IS NO LONGER A PRICING INPUT (2026-08-19) ──────────────────────
  // `style` was passed here and applied decorPricing.STYLE_PREMIUM, a ×0.703125
  // Stage discount for Traditional. Removed on the founder's ruling. The reason
  // is a CONTRADICTION, not a doubt about the pattern: the demo panel's price is
  // style-invariant (verified byte-identical across Modern/Traditional/null on
  // every path), and the panel's midpoint is what publishes via
  // pricing.panelQuote — so a 30% style multiplier here produced a number on the
  // same draft that disagreed with the price the client was actually quoted and
  // the store actually charges. A second opinion nobody acts on.
  // STYLE_PREMIUM is deliberately KEPT in decorPricing with its catalogue
  // evidence — see the note there before re-wiring it anywhere.

  if (!applicable) {
    out.fallbacks.push(`category "${cat}" is not in the pricing model — no price computed`);
    return out;
  }

  const docs = await Decor.find(
    { category: cat, productVisibility: true, productAvailability: true },
    "name productInfo.id productInfo.measurements productTypes image thumbnail"
  ).lean();

  out.pricing = suggestPrice(
    {
      category: cat,
      length: useSize ? analysis.size.length : undefined,
      width: useSize ? analysis.size.width : undefined,
      complexity: complexityTier,
      source: "extension",
      mode: "full",
    },
    docs.map(normalizeComparable)
  );
  return out;
};

// THE BRAIN (2026-08-19: one, not two). FULL mode now returns the pricing
// judgement AND the catalogue copy from a single call, so `analysis` here
// carries suggestedName / description / tags / colors / flowers / fabric /
// included alongside category / size / complexity / style.
const runPricingBrain = async (imageBase64, listingContext) =>
  priceFromAnalysis(await analyseImage({ imageBase64, mode: "full", listingContext }));

// Copy only. Used on a CACHE HIT, where pricing comes from the cached demo read
// (so the draft keeps the exact read the client was quoted from) but that read
// carries no copy fields. One call either way — never two.
const analyseForCopy = async (imageBase64, listingContext) =>
  analyseImage({ imageBase64, mode: "full", listingContext });

// Injection seam so the test suite never calls Anthropic or S3.
const deps = {
  storeRemoteImage,
  toAnalysisBase64,
  runPricingBrain,
  priceFromAnalysis,
  analyseForCopy,
  buildListingContext,
  lookupRead,
  panelQuoteFor,
};

// ─────────────────────────────────────────────────────────────────────────────
// B) POST /decor/drafts — the endpoint the extension calls on A2S click.
// ─────────────────────────────────────────────────────────────────────────────
const createDraft = async ({ imageUrl, pinId, pinText, analysis, force } = {}, actorId) => {
  const url = String(imageUrl || "").trim();
  if (!url) throw err(400, "imageUrl is required");
  if (!/^https?:\/\//i.test(url)) throw err(400, "imageUrl must be an http(s) URL");

  const cleanPinId = pinId ? String(pinId).trim() : "";
  const normalizedUrl = normalizeImageUrl(url);

  // ── H) THREE-STATE DEDUPE — before any fetch or AI spend ──────────────────
  const priors = await DecorDraft.find(dedupeFilterFor({ pinId: cleanPinId, normalizedUrl }))
    .sort({ addedAt: -1 })
    .lean();

  const queued = priors.find((p) => p.status === "queued");
  if (queued) {
    throw err(409, `already queued by ${await nameOf(queued.addedBy)} on ${onDate(queued.addedAt)}`, {
      code: "ALREADY_QUEUED",
      draftId: String(queued._id),
    });
  }

  const approved = priors.find((p) => p.status === "approved");
  if (approved) {
    const published = approved.publishedDecorId
      ? await Decor.findById(approved.publishedDecorId, { "productInfo.id": 1, name: 1 }).lean()
      : null;
    const code = (published && published.productInfo && published.productInfo.id) || approved.draft?.productCode || "—";
    throw err(409, `already in the store as ${code}`, {
      code: "ALREADY_IN_STORE",
      draftId: String(approved._id),
      productCode: code,
      decorId: approved.publishedDecorId ? String(approved.publishedDecorId) : null,
    });
  }

  // Previously REJECTED → do NOT block. Offer the override affordance; a
  // re-POST with { force: true } creates a FRESH draft. The rejected draft is
  // kept, never deleted — "AI proposed, human declined" is training data too.
  const rejected = priors.find((p) => p.status === "rejected");
  if (rejected && !force) {
    throw err(
      409,
      `rejected on ${onDate(rejected.rejection?.rejectedAt || rejected.updatedAt)} by ${await nameOf(
        rejected.rejection?.rejectedBy
      )} — add anyway?`,
      {
        code: "PREVIOUSLY_REJECTED",
        canForce: true,
        draftId: String(rejected._id),
        rejectionReason: rejected.rejection?.reason || "",
      }
    );
  }

  // ── Server-side image adoption + the two brains ──────────────────────────
  const draftId = new mongoose.Types.ObjectId();
  const stored = await deps.storeRemoteImage({ url, path: "decor-drafts", id: String(draftId) });

  // `analysis` in the body short-circuits both brains (used by the test suite
  // and by any caller that already has a full analysis in hand).
  let listing = analysis && analysis.listing ? analysis.listing : null;
  let pricingBrain = analysis && analysis.pricing ? analysis.pricing : null;

  // ── CONSUME THE PANEL'S READ (2026-08-17) ─────────────────────────────────
  // The staff member almost always priced this pin in the panel seconds ago. Its
  // read is cached, so A2S replays it instead of looking at the same photo again.
  // Two things this buys, in order of importance:
  //   1. The draft and the quote describe the SAME read of the image. A2S running
  //      its own vision call is how a pin priced at ₹31k in the panel became ₹93k
  //      in the queue — two temperature-1.0 reads of one photo.
  //   2. One AI call instead of two. The listing brain still runs: a demo read
  //      carries no copy fields (see priceFromAnalysis).
  let sourceRead = { source: "fresh", cacheId: null, firstReadAt: null, usedAt: null };
  let cachedAnalysis = null;
  if (!pricingBrain) {
    try {
      const hit = await deps.lookupRead({ pinId: cleanPinId, normalizedUrl });
      if (hit) {
        cachedAnalysis = hit.analysis;
        pricingBrain = await deps.priceFromAnalysis(hit.analysis);
        // Marks the training record: this "before" came from a stored read taken
        // at firstReadAt, not from a live look at the image now.
        pricingBrain.analysisMode = "demo";
        sourceRead = {
          source: "cache",
          cacheId: hit._id || null,
          firstReadAt: hit.firstReadAt || null,
          usedAt: new Date(),
        };
      }
    } catch (e) {
      // The cache is an optimisation, never a dependency — fall through to a
      // fresh read rather than failing the A2S click.
      console.warn("[A2S] read-cache lookup failed", e && e.message);
    }
  }

  // ── ONE CALL (2026-08-19) ─────────────────────────────────────────────────
  // Pre-merge this was two: a vision+pricing call, then a separate listing call
  // told what the first one had decided. FULL mode now returns both.
  //
  // On a CACHE HIT the pricing half still comes from the cached DEMO read — that
  // is what keeps the draft on the exact read the client was quoted from — and
  // the single call made here supplies only the copy, which a demo read does not
  // carry. So it is one call on a hit and one on a miss, never two.
  if (!pricingBrain || !listing) {
    const b64 = await deps.toAnalysisBase64(stored.buffer);
    // Category-scoped names when the cached read already told us the category;
    // otherwise every name, because on a miss the category is decided by the very
    // call we are about to make. See services/decorListingContext.
    const listingContext = await deps.buildListingContext(
      cachedAnalysis ? cachedAnalysis.category : ""
    );
    if (!pricingBrain) {
      pricingBrain = await deps.runPricingBrain(b64, listingContext);
      pricingBrain.analysisMode = "full";
      sourceRead = { source: "fresh", cacheId: null, firstReadAt: new Date(), usedAt: new Date() };
      // Same call, so the copy is the same read — no second opinion to reconcile.
      if (!listing) listing = pricingBrain.analysis;
    } else if (!listing) {
      // Cache hit: pricing is already settled from the cached read. A copy
      // failure must NOT lose the pricing work, exactly as before.
      try {
        listing = await deps.analyseForCopy(b64, listingContext);
      } catch (e) {
        listing = { error: e.message, code: e.code || "LISTING_FAILED" };
      }
    }
  }

  const visionCategory = (pricingBrain && pricingBrain.analysis && pricingBrain.analysis.category) || "";
  const listingCategory = (listing && listing.category) || "";

  // G) Category disagreement is SIGNAL, not an error — keep both values.
  const categoryDisagreement =
    visionCategory && listingCategory && visionCategory.toLowerCase() !== listingCategory.toLowerCase()
      ? { vision: visionCategory, listing: listingCategory }
      : null;

  const category = visionCategory || listingCategory || "";
  const priceLadder = (pricingBrain && pricingBrain.pricing) || {};

  // The merged brain names the field `suggestedName` (the key /decor/analyse-image
  // has always echoed); `name` is still accepted so a caller supplying its own
  // pre-built analysis keeps working. seoKeywords and occasions are GONE from the
  // listing half by ruling: seoKeywords was unused, and the occasion the pricing
  // brain reads is better — it gave "haldi 85%" where the listing brain guessed
  // four occasions at once.
  const suggested = {
    category,
    name: (listing && (listing.suggestedName || listing.name)) || "",
    description: (listing && listing.description) || "",
    tags: Array.isArray(listing && listing.tags) ? listing.tags : [],
    included: Array.isArray(listing && listing.included) ? listing.included : [],
    attributes: {
      // The scalar style judgement, boxed for the catalogue form — the Style
      // attribute list is exactly ["Modern","Traditional"], so the scalar IS the
      // attribute value. An array from a pre-built analysis passes through.
      style: Array.isArray(listing && listing.style)
        ? listing.style
        : listing && listing.style
          ? [listing.style]
          : [],
      colors: (listing && listing.colors) || [],
      flowers: (listing && listing.flowers) || [],
      fabric: (listing && listing.fabric) || [],
    },
    // Catalogue-shaped {length,width,height,area} — see toCatalogueMeasurements.
    measurements: measurementsFromAnalysis(pricingBrain && pricingBrain.analysis),
    priceLadder,
  };

  // ── THE PANEL'S NUMBER (ruling 3, 2026-08-17) ──────────────────────────────
  // Replayed from the same cached read, so the modal pre-fills with the figure
  // the client was actually quoted — ×1.15 headroom included — rather than the
  // draft engine's independent estimate of the same photo. Only possible when we
  // consumed a cached read; a fresh A2S read was never shown to anyone, so there
  // is no quote to match and this stays null rather than inventing one.
  let panelQuote = null;
  if (cachedAnalysis) {
    try {
      panelQuote = await deps.panelQuoteFor(cachedAnalysis, { pinText });
    } catch (e) {
      console.warn("[A2S] panel quote replay failed", e && e.message);
    }
  }

  const provisionalCode = category ? await suggestProductCode(category) : "";

  const doc = await DecorDraft.create({
    _id: draftId,
    sourceImage: { url, pinId: cleanPinId, normalizedUrl, pinText: String(pinText || "").slice(0, 2000) },
    storedImage: stored.url,
    // IMMUTABLE from here on.
    aiAnalysis: {
      listing: listing || null,
      pricing: pricingBrain || null,
      categoryDisagreement,
    },
    suggested,
    draft: {
      category,
      productCode: provisionalCode,
      name: suggested.name,
      description: suggested.description,
      tags: suggested.tags,
      included: suggested.included,
      unit: category ? await unitFor(category) : "Pc",
      attributes: suggested.attributes,
      measurements: suggested.measurements,
      productVariation: {},
    },
    sourceRead,
    pricing: { aiSuggested: priceLadder, panelQuote },
    status: "queued",
    addedBy: actorId || null,
    addedAt: new Date(),
    supersedesDraftId: rejected ? rejected._id : null,
    history: [
      {
        action: rejected ? "re_added" : "queued",
        by: actorId || null,
        at: new Date(),
        note: rejected ? "re-added after an earlier rejection" : "",
      },
    ],
  });

  return doc.toObject();
};

// ── C) list + detail ────────────────────────────────────────────────────────
const listDrafts = async ({ status, page = 1, limit = 25 } = {}) => {
  const filter = {};
  if (status) {
    if (!["queued", "approved", "rejected"].includes(status)) {
      throw err(400, 'status must be "queued" | "approved" | "rejected"');
    }
    filter.status = status;
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  const [list, total] = await Promise.all([
    DecorDraft.find(filter, { aiAnalysis: 0 }) // full analysis only on detail
      .sort({ addedAt: -1, _id: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate("addedBy", "name")
      .lean(),
    DecorDraft.countDocuments(filter),
  ]);
  return { list, total, page: p, limit: l };
};

const getDraft = async (id) => {
  if (!isId(id)) throw err(400, "Invalid draft id");
  const doc = await DecorDraft.findById(id)
    .populate("addedBy", "name")
    .populate("pricing.decidedBy", "name")
    .lean();
  if (!doc) throw err(404, "Draft not found");
  return doc; // includes the COMPLETE aiAnalysis for the spec pop-up
};

// ── D) approve ──────────────────────────────────────────────────────────────
const approveDraft = async (id, body = {}, actorId) => {
  if (!isId(id)) throw err(400, "Invalid draft id");
  const draft = await DecorDraft.findById(id);
  if (!draft) throw err(404, "Draft not found");
  if (draft.status === "approved") throw err(409, "This draft is already approved");
  if (draft.status === "rejected") throw err(409, "This draft was rejected — re-add the pin to queue it again");

  const category = String(body.category || draft.draft.category || "").trim();
  if (!category) throw err(400, "category is required");
  const name = String(body.name || draft.draft.name || "").trim();
  if (!name) throw err(400, "name is required");

  const productCode = String(body.productCode || draft.draft.productCode || "").trim();
  // Re-check uniqueness AT APPROVE TIME — the approver may have changed it, and
  // the queue may have sat for days.
  if (productCode && (await isCodeTaken(productCode))) {
    throw err(409, `Product code "${productCode}" is already in use. Pick another.`, {
      code: "DUPLICATE_PRODUCT_CODE",
      productCode,
    });
  }

  // Decor requires a non-empty image AND thumbnail. storedImage is set at
  // create time, but fail loudly here rather than surfacing a raw Mongoose
  // ValidationError to the approver.
  if (!draft.storedImage) {
    throw err(422, "This draft has no stored image — re-add the pin so the server can fetch it again");
  }

  // ── PRICE ROWS (2026-08-20) — every tier the approver kept ────────────────
  // Was: ONE row derived from CATEGORY_TIERS[category][0], whatever the human had
  // actually priced. The modal now sends productTypes[] and we publish it as-is.
  // Nothing here validates a row's name against a tier vocabulary, deliberately:
  // Phoolon Ki Chadar and Partitions have an EMPTY Category.productTypes list, so
  // the modal cannot pre-fill them and the approver types the labels. Pathway
  // legitimately carries all four.
  //
  // ⚠️ DEPRECATED FALLBACK: a body with no productTypes but a legacy finalPrice
  // still publishes one derived row, so approvals keep working between this
  // deploy and the modal's. An EMPTY array is REJECTED — that is a modal sending
  // nothing, not an old caller. Delete the fallback once the new modal is live.
  const legacyFinalPrice = Number(body.finalPrice);
  let rows;
  if (Array.isArray(body.productTypes)) {
    if (!body.productTypes.length) {
      throw err(400, "productTypes must not be empty — a product needs at least one price");
    }
    rows = body.productTypes;
  } else if (Number.isFinite(legacyFinalPrice) && legacyFinalPrice > 0) {
    const tiers = CATEGORY_TIERS[category];
    rows = [{
      name: TIER_LABEL[(tiers && tiers[0]) || "flat"] || "Price",
      costPrice: 0,
      sellingPrice: legacyFinalPrice,
      discount: 0,
    }];
  } else {
    throw err(400, "productTypes must be a non-empty array of price rows");
  }

  // Per-row validation. Errors name the row — a bare "invalid price" on a
  // four-tier form does not tell the approver which line to fix.
  const priceRows = rows.map((row, i) => {
    const label = String((row && row.name) || "").trim();
    const at = `row ${i + 1}${label ? ` ("${label}")` : ""}`;
    if (!label) throw err(400, `${at}: name is required`);
    const sellingPrice = Number(row.sellingPrice);
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
      throw err(400, `${at}: sellingPrice must be a positive number`);
    }
    const costPrice = row.costPrice === undefined || row.costPrice === null ? 0 : Number(row.costPrice);
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      throw err(400, `${at}: costPrice cannot be negative`);
    }
    const discount = row.discount === undefined || row.discount === null ? 0 : Number(row.discount);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw err(400, `${at}: discount must be between 0 and 100`);
    }
    // THE TRAINING LOOP, now per tier: an override without a reason is a lost
    // training pair; accepting the AI price IS the positive signal and needs no
    // reason. A top-level reason still covers every row, so a modal with one
    // reason box for the whole form keeps working.
    const rowOverridden = row.overridden === undefined ? body.overridden === true : row.overridden === true;
    const rowReason =
      (typeof row.reason === "string" && row.reason.trim()) ||
      (typeof body.reason === "string" && body.reason.trim()) ||
      "";
    if (rowOverridden && !rowReason) {
      throw err(400, `${at}: a reason is required when you override the AI's suggested price`);
    }
    return { name: label, costPrice, sellingPrice, discount, overridden: rowOverridden, reason: rowReason };
  });

  const description = body.description !== undefined ? String(body.description) : draft.draft.description;
  const tags = Array.isArray(body.tags) ? body.tags : draft.draft.tags || [];
  const included = Array.isArray(body.included) ? body.included : draft.draft.included || [];
  const unit = String(body.unit || draft.draft.unit || "").trim() || (await unitFor(category));
  // Rescues a stageMeasurements-shaped draft and passes a catalogue-shaped one
  // through untouched — see toCatalogueMeasurements. Without it every CACHE-HIT
  // draft published length/width 0 and was excluded from size-matched pricing.
  const measurements = toCatalogueMeasurements(body.measurements || draft.draft.measurements || {});

  // Pass-through fields the approval form now sends. Each falls back to what the
  // draft already held and then to the schema default — approving must never
  // blank a field the form simply did not include.
  const arr = (v, fallback) => (Array.isArray(v) ? v : Array.isArray(fallback) ? fallback : []);
  const obj = (v, fallback) =>
    v && typeof v === "object" && !Array.isArray(v) ? v : fallback && typeof fallback === "object" ? fallback : {};

  const decorDoc = {
    category,
    name,
    unit,
    description,
    tags,
    label: String(body.label || ""),
    image: draft.storedImage || "",
    thumbnail: draft.storedImage || "",
    additionalImages: arr(body.additionalImages),
    video: String(body.video || ""),
    // ── LIVE ON APPROVE (2026-08-20) ────────────────────────────────────────
    // Both were hardcoded false, so a product landed in the collection invisible
    // and unbuyable and needed a second manual switch nobody was told about.
    // Founder's ruling: approving IS publishing.
    productVisibility: true,
    productAvailability: true,
    productTypes: priceRows.map(({ name: n, costPrice, sellingPrice, discount }) => ({
      name: n, costPrice, sellingPrice, discount,
    })),
    attributes: arr(body.attributes),
    productVariation: obj(body.productVariation, draft.draft.productVariation),
    productVariants: arr(body.productVariants),
    productAddOns: arr(body.productAddOns),
    rawMaterials: arr(body.rawMaterials),
    // seoTags is DROPPED by ruling — `tags` is the only tag surface. Neither
    // accepted from the body nor written, so the schema default stands.
    productInfo: {
      id: productCode,
      included,
      measurements,
    },
  };

  let created;
  try {
    created = await new Decor(decorDoc).save();
  } catch (e) {
    if (e && e.code === 11000) {
      throw err(409, `Product code "${productCode}" was taken while you were approving. Pick another.`, {
        code: "DUPLICATE_PRODUCT_CODE",
        productCode,
      });
    }
    throw e;
  }

  // Record the decision. aiAnalysis / pricing.aiSuggested are NOT touched —
  // the model's pre-save hook would throw if they were.
  draft.draft.category = category;
  draft.draft.productCode = productCode;
  draft.draft.name = name;
  draft.draft.description = description;
  draft.draft.tags = tags;
  draft.draft.included = included;
  draft.draft.unit = unit;
  draft.draft.measurements = measurements;

  // ── THE LEARNING RECORD, NOW PER TIER ─────────────────────────────────────
  // For each PUBLISHED row: what the AI ladder suggested for that tier, what the
  // panel quoted, what the human set, and why if it differs. aiSuggested and
  // panelQuote are IMMUTABLE and are read here, never written.
  const aiLadder = (draft.pricing.aiSuggested && draft.pricing.aiSuggested.suggested) || {};
  const panel = draft.pricing.panelQuote || null;
  const tierDecisions = priceRows.map((row) => {
    const tier = tierOf(row.name);
    const aiNum = Number(aiLadder[tier]);
    const ai = Number.isFinite(aiNum) && aiNum > 0 ? aiNum : null;
    return {
      tier,
      name: row.name,
      aiSuggested: ai,
      // The panel quotes exactly ONE tier. Recording its midpoint against any
      // other tier would invent a comparison nobody was ever shown.
      panelQuote:
        panel && panel.tier === tier && Number.isFinite(Number(panel.midpoint))
          ? Number(panel.midpoint)
          : null,
      finalPrice: row.sellingPrice,
      overridden: row.overridden,
      reason: row.reason,
      deltaPct: ai ? Number((((row.sellingPrice - ai) / ai) * 100).toFixed(1)) : null,
    };
  });

  // The HEADLINE row keeps the legacy fields' exact meaning — "the price this
  // draft published" — so every draft already in the collection still reads the
  // same way and nothing needs backfilling.
  const headline = tierDecisions[0];
  draft.pricing.tierDecisions = tierDecisions;
  draft.pricing.finalPrice = headline.finalPrice;
  draft.pricing.overridden = tierDecisions.some((t) => t.overridden);
  draft.pricing.reason = (tierDecisions.find((t) => t.overridden && t.reason) || { reason: "" }).reason;
  draft.pricing.decidedBy = actorId || null;
  draft.pricing.decidedAt = new Date();
  draft.status = "approved";
  draft.publishedDecorId = created._id;
  draft.history.push({
    action: "approved",
    by: actorId || null,
    at: new Date(),
    note: draft.pricing.overridden
      ? `${tierDecisions.filter((t) => t.overridden).length} of ${tierDecisions.length} tier(s) overridden: ${draft.pricing.reason}`
      : `accepted the AI price on all ${tierDecisions.length} tier(s)`,
  });
  await draft.save();

  return { draft: draft.toObject(), decorId: created._id, productCode };
};

// ── D) reject ───────────────────────────────────────────────────────────────
const rejectDraft = async (id, { reason } = {}, actorId) => {
  if (!isId(id)) throw err(400, "Invalid draft id");
  const draft = await DecorDraft.findById(id);
  if (!draft) throw err(404, "Draft not found");
  if (draft.status === "approved") throw err(409, "This draft is already approved — nothing to reject");
  if (draft.status === "rejected") return draft.toObject(); // idempotent

  const clean = typeof reason === "string" ? reason.trim() : "";
  draft.status = "rejected";
  draft.rejection = { reason: clean, rejectedBy: actorId || null, rejectedAt: new Date() };
  draft.history.push({ action: "rejected", by: actorId || null, at: new Date(), note: clean });
  await draft.save();
  return draft.toObject(); // KEPT, never deleted — training data
};

module.exports = {
  createDraft,
  listDrafts,
  getDraft,
  approveDraft,
  rejectDraft,
  normalizeImageUrl,
  toCatalogueMeasurements,
  measurementsFromAnalysis,
  runPricingBrain,
  priceFromAnalysis,
  __deps: deps, // test seam
};

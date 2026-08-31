const mongoose = require("mongoose");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const { suggestProductCode, isCodeTaken } = require("../utils/decorCode");
const { storeRemoteImage, storeUploadedImage, toAnalysisBase64, fetchRemoteImage } = require("../utils/remoteImageToS3");
const { analyseImage, CATEGORY_LIST } = require("./decorVision");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("./decorPricing");
const { OCCASIONS } = require("./decorDemoPrice");
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
  storeUploadedImage,
  toAnalysisBase64,
  runPricingBrain,
  priceFromAnalysis,
  analyseForCopy,
  // Upload intake reads in DEMO mode: the demo schema carries the measurement
  // and occasion fields the quote engine consumes, and priceFromAnalysis
  // documents a demo read as a valid pricing input.
  analyseForUpload: (imageBase64) => analyseImage({ imageBase64, mode: "demo" }),
  buildListingContext,
  fetchRemoteImage,
  // The copy pass is scheduled, never awaited — the response must not wait on it.
  scheduleCopyPass: (draftId, buffer) =>
    setImmediate(() => {
      runCopyPass(draftId, { buffer }).catch((e) => console.warn("[A2S] copy pass threw", e && e.message));
    }),
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

  // ── SECURE THE IMAGE, REPLY, WRITE THE COPY AFTER (2026-08-20) ────────────
  // A2S used to do everything before replying and the staff member watched a
  // spinner for 10-20 seconds. The image comes first because it is the
  // IRREPLACEABLE part: a Pinterest URL can rot, and once the asset is in S3 it
  // is ours. The copy is regenerable — the same brain now backs the product
  // form's AI Analyse button — so a draft with an image and a price is genuinely
  // usable even if the copy never runs.
  //
  // WHICH PATH DEFERS, and it is the inverse of what you would guess:
  //   CACHE MISS — one merged call returns pricing AND copy together, so the
  //     copy is already in hand and there is nothing to defer. copy: "ready".
  //   CACHE HIT  — the price comes from the cached read at no AI cost, and the
  //     copy is then the ONLY remaining model call. That is the call we defer,
  //     and the hit is the normal path because the panel prices a pin before
  //     anyone clicks A2S.
  let copyDeferred = false;
  if (!pricingBrain || !listing) {
    if (!pricingBrain) {
      const b64 = await deps.toAnalysisBase64(stored.buffer);
      // On a miss the category is decided by the very call we are about to make,
      // so names cannot be category-scoped here. See services/decorListingContext.
      const listingContext = await deps.buildListingContext("");
      pricingBrain = await deps.runPricingBrain(b64, listingContext);
      pricingBrain.analysisMode = "full";
      sourceRead = { source: "fresh", cacheId: null, firstReadAt: new Date(), usedAt: new Date() };
      // Same call, so the copy is the same read — no second opinion to reconcile.
      if (!listing) listing = pricingBrain.analysis;
    } else if (!listing) {
      copyDeferred = true;
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
    // pending is written BEFORE the copy pass starts, so an interrupted run is
    // indistinguishable from one that never started — see the note on the model.
    copy: copyDeferred
      ? { status: "pending", attempts: 0 }
      : { status: "ready", completedAt: new Date(), categoryDisagreement },
    copyAnalysis: copyDeferred ? null : listing || null,
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

  // Hand back immediately; the copy runs after the response is on its way.
  // deps.scheduleCopyPass is a seam so tests can drive it deterministically.
  if (copyDeferred) deps.scheduleCopyPass(doc._id, stored.buffer);
  return doc.toObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// BULK UPLOAD — POST /decor/drafts/uploads. Staff bytes in, queued drafts out.
//
// The shape is the CACHE-HIT path inverted: one demo-mode read at create
// settles the price, the copy is deferred to the existing copy pass. What
// makes it different from A2S:
//   • no pin and no panel — sourceRead.source "upload", panelQuote stays null,
//     and the occasion-aware figure lands in pricing.uploadQuote instead;
//   • category and occasion are STAFF STATEMENTS, honoured together (ruling:
//     no DemoPrice-style suppression) — category via a synthetic clone of the
//     read (Seam B, the categoryOverride precedent), occasion via the explicit
//     parameter on panelQuoteFor (Seam A);
//   • aiAnalysis stays what the AI actually said. The staff category reaches
//     draft.category and the pricing clone ONLY; suggested.category keeps the
//     vision value; a disagreement is recorded on upload.categoryDisagreement.
//   • an AI rejection (isDecorProduct false) does not veto the draft — staff
//     deliberately uploaded it — but it is never papered over with a price:
//     no quote is computed, and uploadQuote says so (status "no_quote",
//     reason "ai_rejected") where both sales and the approver will see it.

const createUploadDraft = async (
  { buffer, originalFilename, category, occasion } = {},
  { batchId, position } = {},
  actorId
) => {
  if (!buffer || !buffer.length) throw err(400, "an image file is required");
  const cat = String(category || "").trim();
  if (!cat) throw err(400, "category is required");
  if (!CATEGORY_LIST.includes(cat)) {
    throw err(400, `Unknown décor category: ${JSON.stringify(cat)}`);
  }
  // "" is an EXPLICIT "no occasion" — Seam A still gets null, not undefined,
  // because staff stating none must not be overridden by the vision read's
  // guess. (Haldi is reached as Stage + occasion haldi, never as a category:
  // CATEGORY_LIST does not contain the demo-only Haldi entry, by design.)
  const occ = String(occasion || "").trim().toLowerCase();
  if (occ && !OCCASIONS.includes(occ)) {
    throw err(400, `Unknown occasion: ${JSON.stringify(occ)} (one of ${OCCASIONS.join(", ")}, or empty for none)`);
  }

  const draftId = new mongoose.Types.ObjectId();
  const stored = await deps.storeUploadedImage({ buffer, path: "decor-drafts", id: String(draftId) });

  const b64 = await deps.toAnalysisBase64(stored.buffer);
  const demoAnalysis = await deps.analyseForUpload(b64);

  // The AI ladder — computed from the UNMODIFIED read. This is the immutable
  // "before": what the AI said, staff statements nowhere in it.
  const pricingBrain = await deps.priceFromAnalysis(demoAnalysis);
  pricingBrain.analysisMode = "demo"; // the read's SHAPE; provenance is sourceRead

  const inputs = { category: cat, occasion: occ || null };
  let uploadQuote;
  if (!demoAnalysis || demoAnalysis.isDecorProduct === false) {
    // The AI's rejection is NOT overridden into a confident price. The draft
    // still exists (staff asserted a product); the blank says why.
    uploadQuote = {
      status: "no_quote",
      reason: "ai_rejected",
      detail:
        (demoAnalysis && demoAnalysis.complexity && demoAnalysis.complexity.reasoning) ||
        "the vision model did not read this as a décor product",
      inputs,
    };
  } else {
    // ── Seam B — the synthetic clone (the categoryOverride precedent) ───────
    // Staff said what it is: category asserted, categoryConfidence null because
    // no model judged THIS category. isDecorProduct is NOT asserted — it is
    // inherited from the read, and the rejected case never reaches this branch.
    // Everything measured — size, complexity, stageMeasurements,
    // recommendedSize — stays the AI's own reading. The clone is consumed by
    // the quote and NEVER persisted.
    const priced = { ...demoAnalysis, category: cat, categoryConfidence: null };
    const staffOccasion = occ ? { value: occ, source: "staff", conflict: null } : null;
    try {
      const quote = await deps.panelQuoteFor(priced, { occasion: staffOccasion });
      uploadQuote = quote
        ? { status: "quoted", ...quote, inputs }
        : { status: "no_quote", reason: "no_price", detail: `no priceable figure for ${cat}`, inputs };
    } catch (e) {
      uploadQuote = {
        status: "no_quote",
        reason: "quote_failed",
        detail: String((e && e.message) || e).slice(0, 300),
        inputs,
      };
      console.warn("[A2S:upload] quote failed", e && e.message);
    }
  }

  const visionCategory = (demoAnalysis && demoAnalysis.category) || "";
  const categoryDisagreement =
    visionCategory && visionCategory.toLowerCase() !== cat.toLowerCase()
      ? { vision: visionCategory, staff: cat }
      : null;

  const measurements = measurementsFromAnalysis(demoAnalysis);
  const now = new Date();

  const doc = await DecorDraft.create({
    _id: draftId,
    sourceImage: { url: stored.url, pinId: "", normalizedUrl: normalizeImageUrl(stored.url), pinText: "" },
    storedImage: stored.url,
    // IMMUTABLE — and PURELY the AI's: listing arrives via the copy pass into
    // copyAnalysis (it cannot be patched in here), and the staff-vs-vision
    // disagreement lives on upload.categoryDisagreement, not in this blob.
    aiAnalysis: { listing: null, pricing: pricingBrain, categoryDisagreement: null },
    suggested: {
      category: visionCategory, // what the AI said — NOT the staff category
      name: "",
      description: "",
      tags: [],
      included: [],
      attributes: {},
      measurements,
      priceLadder: (pricingBrain && pricingBrain.pricing) || {},
    },
    draft: {
      category: cat, // what staff said — the approver's working copy starts here
      productCode: await suggestProductCode(cat),
      name: "",
      description: "",
      tags: [],
      included: [],
      unit: await unitFor(cat),
      attributes: {},
      measurements,
      productVariation: {},
    },
    sourceRead: { source: "upload", cacheId: null, firstReadAt: now, usedAt: now },
    pricing: { aiSuggested: (pricingBrain && pricingBrain.pricing) || {}, panelQuote: null, uploadQuote },
    status: "queued",
    copy: { status: "pending", attempts: 0 },
    copyAnalysis: null,
    addedBy: actorId || null,
    addedAt: now,
    upload: {
      batchId,
      position,
      originalFilename: String(originalFilename || "").slice(0, 300),
      category: cat,
      occasion: occ,
      categoryDisagreement,
    },
    history: [
      {
        action: "queued",
        by: actorId || null,
        at: now,
        note:
          uploadQuote.reason === "ai_rejected"
            ? `uploaded as ${cat} — the AI did not read this as a décor product, so no price was computed`
            : categoryDisagreement
              ? `uploaded — staff said ${cat}, the AI read ${visionCategory}`
              : "uploaded",
      },
    ],
  });

  deps.scheduleCopyPass(doc._id, stored.buffer);
  return doc.toObject();
};

// The batch: mints ONE batchId, creates SEQUENTIALLY — suggestProductCode
// treats a queued draft's code as a reservation, so each draft must be
// persisted before the next asks for a code, or five same-category uploads
// would all be handed the same provisional. Per-item failure does not abort
// the batch: four good drafts and one clear error beats an all-or-nothing 500.
const createUploadBatch = async ({ items } = {}, actorId) => {
  if (!Array.isArray(items) || !items.length) throw err(400, "at least one image is required");
  if (items.length > 5) throw err(400, "at most 5 images per batch");
  const batchId = new mongoose.Types.ObjectId();
  const results = [];
  for (let position = 0; position < items.length; position++) {
    try {
      const draft = await createUploadDraft(items[position], { batchId, position }, actorId);
      results.push({ position, status: "queued", draft });
    } catch (e) {
      results.push({
        position,
        status: "failed",
        error: (e && e.message) || "error",
        httpStatus: (e && e.status) || 500,
      });
    }
  }
  return { batchId: String(batchId), results };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE COPY PASS — runs AFTER the reply, on the server.
//
// MECHANISM: an in-process deferred call (setImmediate), not a client callback.
// The staff member will navigate to the next pin, reload, or close the tab the
// moment they get their draft id, so returning early from the extension is not
// enough — the work has to already be off the request. It is.
//
// WHAT A pm2 RESTART DOES (a deploy mid-copy): nothing that needs recovering.
// copy.status is written "pending" as part of the draft's own create, before any
// work begins, and only a SUCCESSFUL pass moves it to "ready". So an interrupted
// draft is left exactly "pending" — the same state as one whose pass has not
// started — which is the "needs writing" bucket Rohaan already filters on. The
// patch is a single atomic updateOne, so there is no half-written middle state
// either. Recovery is therefore a re-run, not a repair: POST
// /decor/drafts/:id/copy, or a sweep over { "copy.status": "pending" } if this
// ever wants to be automatic.
//
// The image buffer is passed in on the immediate path (it is already in hand)
// and RE-FETCHED FROM S3 on a retry, which is why retry works after a restart.
const runCopyPass = async (draftId, { buffer = null, force = false } = {}) => {
  const draft = await DecorDraft.findById(draftId).lean();
  if (!draft) return { skipped: "gone" };
  // ── THE ALREADY-WRITTEN GUARD, and what it is actually for ────────────────
  // It exists to stop the AUTOMATIC path burning a second model call on
  // accidental re-entry — a double-schedule, or a future sweep over pending
  // drafts that races a pass already in flight. That reason is real, so the
  // guard stays.
  //
  // It must NOT apply to an explicit retry. POST /decor/drafts/:id/copy is a
  // human asking for the copy again — usually for a better name on a draft
  // whose copy is already "ready" — and the guard used to swallow exactly that
  // call, returning {skipped:"already written"} with a 200 and doing nothing.
  //
  // `force` rather than "was a buffer passed": buffer-presence happens to line
  // up with the create path today, but it conflates "do I have the bytes in
  // hand" with "did a human ask for this". A recovery sweep would call this with
  // no buffer and would then be treated as an explicit retry, re-running the AI
  // on drafts that are already done. Intent is the thing being tested, so intent
  // is what the parameter says.
  if (!force && draft.copy && draft.copy.status === "ready") {
    return { skipped: "already written" };
  }

  await DecorDraft.updateOne(
    { _id: draftId },
    { $set: { "copy.status": "pending", "copy.startedAt": new Date() }, $inc: { "copy.attempts": 1 } }
  );

  try {
    const buf = buffer || (await deps.fetchRemoteImage(draft.storedImage)).buffer;
    const b64 = await deps.toAnalysisBase64(buf);
    const visionCategory =
      (draft.aiAnalysis && draft.aiAnalysis.pricing && draft.aiAnalysis.pricing.analysis
        && draft.aiAnalysis.pricing.analysis.category) || "";
    // Upload drafts scope the naming context to the STAFF category — it is the
    // category the product will publish under. Extension drafts keep the vision
    // category, unchanged. The disagreement check below stays AI-vs-AI either way.
    const contextCategory =
      draft.upload && draft.upload.batchId
        ? (draft.draft && draft.draft.category) || visionCategory
        : visionCategory;
    const listingContext = await deps.buildListingContext(contextCategory);
    const copy = await deps.analyseForCopy(b64, listingContext);

    const listingCategory = (copy && copy.category) || "";
    const disagreement =
      visionCategory && listingCategory && visionCategory.toLowerCase() !== listingCategory.toLowerCase()
        ? { vision: visionCategory, listing: listingCategory }
        : null;

    const name = (copy && (copy.suggestedName || copy.name)) || "";
    const description = (copy && copy.description) || "";
    const tags = Array.isArray(copy && copy.tags) ? copy.tags : [];
    const included = Array.isArray(copy && copy.included) ? copy.included : [];
    const attributes = {
      style: copy && copy.style ? (Array.isArray(copy.style) ? copy.style : [copy.style]) : [],
      colors: (copy && copy.colors) || [],
      flowers: (copy && copy.flowers) || [],
      fabric: (copy && copy.fabric) || [],
    };

    // `suggested` is WHAT THE AI SAID and is always overwritten. `draft` is the
    // approver's working copy, so each field is filled ONLY if still empty — a
    // human who started typing while the pass was in flight does not get
    // overwritten by it.
    const fresh = await DecorDraft.findById(draftId).lean();
    if (!fresh || fresh.status !== "queued") return { skipped: "no longer queued" };
    const fillIfEmpty = {};
    if (!fresh.draft.name) fillIfEmpty["draft.name"] = name;
    if (!fresh.draft.description) fillIfEmpty["draft.description"] = description;
    if (!(fresh.draft.tags || []).length) fillIfEmpty["draft.tags"] = tags;
    if (!(fresh.draft.included || []).length) fillIfEmpty["draft.included"] = included;
    if (!fresh.draft.attributes || !Object.keys(fresh.draft.attributes).length) {
      fillIfEmpty["draft.attributes"] = attributes;
    }

    // ONE atomic write — the reason a draft is never half-written.
    await DecorDraft.updateOne(
      { _id: draftId },
      {
        $set: {
          copyAnalysis: copy,
          "suggested.name": name,
          "suggested.description": description,
          "suggested.tags": tags,
          "suggested.included": included,
          "suggested.attributes": attributes,
          ...fillIfEmpty,
          "copy.status": "ready",
          "copy.lastError": "",
          "copy.completedAt": new Date(),
          "copy.categoryDisagreement": disagreement,
        },
      }
    );
    return { status: "ready" };
  } catch (e) {
    await DecorDraft.updateOne(
      { _id: draftId },
      { $set: { "copy.status": "failed", "copy.lastError": String((e && e.message) || e).slice(0, 500) } }
    );
    console.warn("[A2S] copy pass failed", draftId, e && e.message);
    return { status: "failed", error: (e && e.message) || String(e) };
  }
};

// POST /decor/drafts/:id/copy — re-run from the approvals queue. Re-fetches the
// stored S3 image, so it works long after the original request's buffer is gone
// and after any number of restarts.
const retryCopy = async (draftId) => {
  if (!isId(draftId)) throw err(400, "Invalid draft id");
  const draft = await DecorDraft.findById(draftId).lean();
  if (!draft) throw err(404, "Draft not found");
  if (draft.status !== "queued") throw err(409, `This draft is ${draft.status} — the copy can only be re-run while it is queued`);
  if (!draft.storedImage) throw err(422, "This draft has no stored image — re-add the pin so the server can fetch it again");
  // Deliberately allowed on a "ready" draft too: re-running the copy is how an
  // approver asks for a better name, not only how they recover a failure. That
  // is what `force` is for — without it the already-written guard swallows this
  // call. No buffer: the stored S3 image is re-fetched, which is why retry works
  // after a restart.
  const result = await runCopyPass(draftId, { force: true });
  return { draft: (await DecorDraft.findById(draftId).lean()), ...result };
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
  if (!name) {
    // A pending/failed copy does NOT block approval — the approver just has to
    // supply the name themselves, which is the whole point of the third state.
    const pendingCopy = draft.copy && draft.copy.status !== "ready";
    throw err(400, pendingCopy
      ? "name is required — the AI copy for this draft hasn't been written yet, so type a name or re-run the copy pass"
      : "name is required");
  }

  // ── PRODUCT CODE (2026-08-21) ─────────────────────────────────────────────
  // Re-checked AT APPROVE TIME — the approver may have changed it, and the queue
  // may have sat for days while the catalogue moved underneath it.
  //
  // AUTO-ADVANCE, but only past a code NOBODY CHOSE. A provisional code is a
  // server-generated guess; when it turns out to be taken, silently taking the
  // next free one costs the approver nothing. A code the approver TYPED is a
  // decision, and overriding a human's explicit choice without saying so would
  // be far worse than refusing — so that still 409s.
  //
  // The signal is whether the submitted code differs from the one this draft was
  // created with. Equal, or absent, means the modal sent back the suggestion
  // untouched.
  const submittedCode = String(body.productCode || "").trim();
  const provisionalCodeOnDraft = String(draft.draft.productCode || "").trim();
  const codeWasChosenByHuman = !!submittedCode && submittedCode !== provisionalCodeOnDraft;
  let productCode = submittedCode || provisionalCodeOnDraft;
  let codeAutoAssigned = null;

  if (productCode && (await isCodeTaken(productCode))) {
    if (codeWasChosenByHuman) {
      throw err(409, `Product code "${productCode}" is already in use. Pick another.`, {
        code: "DUPLICATE_PRODUCT_CODE",
        productCode,
      });
    }
    // excludeDraftId so this draft does not treat its OWN reservation as a
    // reason to skip a code.
    const next = await suggestProductCode(category, { excludeDraftId: draft._id });
    if (!next || (await isCodeTaken(next))) {
      // Could not derive a free code — refuse rather than publish an empty or
      // colliding one.
      throw err(409, `Product code "${productCode}" is already in use. Pick another.`, {
        code: "DUPLICATE_PRODUCT_CODE",
        productCode,
      });
    }
    codeAutoAssigned = { from: productCode, to: next };
    productCode = next;
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

  // ── DIMENSION CORRECTIONS (2026-08-20) ────────────────────────────────────
  // The "before" half comes from the IMMUTABLE aiAnalysis, computed here — never
  // from the request. The client is trusted for what the human chose, never for
  // what the AI said; a body that could set aiRead could make any correction
  // look like an agreement. Same principle as pricing.aiSuggested.
  //
  // draft.draft.measurements is deliberately NOT the source: it is the mutable
  // pre-fill and may already carry an earlier human edit.
  const aiMeasurements = measurementsFromAnalysis(
    draft.aiAnalysis && draft.aiAnalysis.pricing ? draft.aiAnalysis.pricing.analysis : null
  );
  // ONE SHARED REASON covers price and size (founder ruling). A category
  // correction rides in this same text rather than getting a record of its own.
  const sharedReason = typeof body.reason === "string" ? body.reason.trim() : "";
  const measurementDecisions = ["length", "width", "height"].map((field) => {
    const aiRaw = Number(aiMeasurements[field]);
    const aiRead = Number.isFinite(aiRaw) && aiRaw > 0 ? aiRaw : null;
    const finalRaw = Number(measurements[field]);
    const finalValue = Number.isFinite(finalRaw) ? finalRaw : 0;
    // A move is only a CORRECTION when there was a reading to correct. With no
    // AI reading there is nothing the human contradicted, so it is not an
    // override and demanding a reason for it would be noise.
    const overridden = aiRead !== null && finalValue !== aiRead;
    return {
      field,
      aiRead,
      finalValue,
      overridden,
      reason: overridden ? sharedReason : "",
      deltaPct: aiRead ? Number((((finalValue - aiRead) / aiRead) * 100).toFixed(1)) : null,
    };
  });

  // Mirrors the per-tier rule: a correction without a reason is a lost training
  // pair, and silently dropping the explanation is exactly the bug this fixes.
  const movedDims = measurementDecisions.filter((m) => m.overridden);
  if (movedDims.length && !sharedReason) {
    throw err(
      400,
      `A reason is required when you change the ${movedDims.map((m) => m.field).join(", ")} the AI measured`
    );
  }

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
    // Stamps the published product's origin. A real field, not a tag: an
    // approver editing tags cannot delete it, and GET /decor can filter on it.
    // Upload-born drafts stamp "upload" — origin is derived from
    // upload.batchId, the same rule the queue's tabs use.
    source: draft.upload && draft.upload.batchId ? "upload" : "extension",
    // The APPROVER, not draft.addedBy. Same meaning as on POST /decor — "the
    // person who put this product in the catalogue" — because a filter whose
    // meaning changes with the creation path is not a filter. The person who
    // clicked A2S stays visible as addedBy on GET /decor/:_id/analysis, which is
    // where the two can legitimately be days apart.
    createdBy: actorId || null,
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
  draft.pricing.measurementDecisions = measurementDecisions;
  draft.pricing.finalPrice = headline.finalPrice;
  // `overridden` keeps meaning THE PRICE WAS OVERRIDDEN — tiers only. A height
  // correction must not flip it: that would make a draft where the human
  // ACCEPTED the AI price read as a price override, poisoning the one signal the
  // price training loop depends on.
  draft.pricing.overridden = tierDecisions.some((t) => t.overridden);
  // `reason` no longer derives from tiers ALONE. A dimension-only correction
  // used to set this to "" and lose the approver's explanation outright; now the
  // shared text survives whichever half of the decision moved. Tier reasons keep
  // precedence so existing records read exactly as before.
  draft.pricing.reason =
    (tierDecisions.find((t) => t.overridden && t.reason) || { reason: "" }).reason ||
    (measurementDecisions.find((m) => m.overridden && m.reason) || { reason: "" }).reason ||
    "";
  draft.pricing.decidedBy = actorId || null;
  draft.pricing.decidedAt = new Date();
  draft.status = "approved";
  draft.publishedDecorId = created._id;
  if (codeAutoAssigned) {
    draft.history.push({
      action: "code_reassigned",
      by: actorId || null,
      at: new Date(),
      note: `provisional code ${codeAutoAssigned.from} was already in use — published as ${codeAutoAssigned.to}`,
    });
  }
  draft.history.push({
    action: "approved",
    by: actorId || null,
    at: new Date(),
    note: draft.pricing.overridden
      ? `${tierDecisions.filter((t) => t.overridden).length} of ${tierDecisions.length} tier(s) overridden: ${draft.pricing.reason}`
      : movedDims.length
        ? `accepted the AI price; corrected ${movedDims.map((m) => m.field).join(", ")}: ${draft.pricing.reason}`
        : `accepted the AI price on all ${tierDecisions.length} tier(s)`,
  });
  await draft.save();

  // The approver must not learn the code changed by noticing it later.
  return {
    draft: draft.toObject(),
    decorId: created._id,
    productCode,
    ...(codeAutoAssigned ? { codeAutoAssigned } : {}),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// E) REVERSE LOOKUP — the AI analysis behind a PUBLISHED product.
//
// A read, never a copy. draft.aiAnalysis is immutable and is the training
// record, so it stays the single source of truth: nothing is duplicated onto the
// Decor document, and editing a product can never drift its analysis.
//
// The link already exists — DecorDraft.publishedDecorId is stamped on approve —
// so this is just that index read backwards.
//
// Throws 404 with code NO_DRAFT when a product has no draft. That is the NORMAL
// case, not an error: every manually-created product and all ~800 predating A2S
// will land here, and the catalogue uses the miss to decide whether to show the
// tab at all. The code is what it should branch on, not the message.
const analysisForDecor = async (decorId) => {
  if (!isId(decorId)) throw err(400, "Invalid decor id");
  const draft = await DecorDraft.findOne({ publishedDecorId: decorId })
    .sort({ addedAt: -1, _id: -1 })
    .populate("pricing.decidedBy", "name")
    .populate("addedBy", "name")
    .lean();
  if (!draft) {
    throw err(404, "This product wasn't added from the extension, so there's no AI analysis for it.", {
      code: "NO_DRAFT",
    });
  }
  return draft;
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
  createUploadDraft,
  createUploadBatch,
  listDrafts,
  getDraft,
  approveDraft,
  rejectDraft,
  runCopyPass,
  retryCopy,
  analysisForDecor,
  normalizeImageUrl,
  toCatalogueMeasurements,
  measurementsFromAnalysis,
  runPricingBrain,
  priceFromAnalysis,
  __deps: deps, // test seam
};

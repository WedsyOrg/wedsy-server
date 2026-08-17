const mongoose = require("mongoose");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const { suggestProductCode, isCodeTaken } = require("../utils/decorCode");
const { storeRemoteImage, toAnalysisBase64 } = require("../utils/remoteImageToS3");
const { analyseImage } = require("./decorVision");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("./decorPricing");
const { analyseListing } = require("./decorListing");
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
// is why A2S can drop to one AI call while still needing analyseListing.
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
  const style =
    cat === "Stage" && (analysis.style === "Modern" || analysis.style === "Traditional")
      ? analysis.style
      : undefined;

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
      style,
      complexity: complexityTier,
      source: "extension",
      mode: "full",
    },
    docs.map(normalizeComparable)
  );
  return out;
};

// Brain 2: vision + pricing. Mirrors POST /decor/analyse-image, but keeps the
// FULL result (shapeClientResponse trims the wire response, not this).
const runPricingBrain = async (imageBase64) =>
  priceFromAnalysis(await analyseImage({ imageBase64, mode: "full" }));

// Injection seam so the test suite never calls Anthropic or S3.
const deps = {
  storeRemoteImage,
  toAnalysisBase64,
  runPricingBrain,
  priceFromAnalysis,
  analyseListing,
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

  // The listing brain always needs the image; the pricing brain needs it only on
  // a cache miss. Compute the base64 once, and only if something still has to run.
  if (!pricingBrain || !listing) {
    const b64 = await deps.toAnalysisBase64(stored.buffer);
    if (!pricingBrain) {
      pricingBrain = await deps.runPricingBrain(b64);
      pricingBrain.analysisMode = "full";
      sourceRead = { source: "fresh", cacheId: null, firstReadAt: new Date(), usedAt: new Date() };
    }
    if (!listing) {
      // The vision brain names the category; the listing brain is told what it
      // is looking at. A listing failure must NOT lose the pricing work.
      try {
        listing = await deps.analyseListing({
          imageBase64: b64,
          category: pricingBrain.analysis && pricingBrain.analysis.category,
        });
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

  const suggested = {
    category,
    name: (listing && listing.name) || "",
    description: (listing && listing.description) || "",
    tags: Array.isArray(listing && listing.tags) ? listing.tags : [],
    included: Array.isArray(listing && listing.included) ? listing.included : [],
    attributes: {
      style: (listing && listing.style) || [],
      colors: (listing && listing.colors) || [],
      flowers: (listing && listing.flowers) || [],
      occasions: (listing && listing.occasions) || [],
      seoKeywords: (listing && listing.seoKeywords) || [],
    },
    measurements:
      (pricingBrain && pricingBrain.analysis && pricingBrain.analysis.stageMeasurements) ||
      (pricingBrain && pricingBrain.analysis && pricingBrain.analysis.size) ||
      {},
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

  const overridden = body.overridden === true;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const finalPrice = Number(body.finalPrice);

  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    throw err(400, "finalPrice must be a positive number");
  }
  // THE TRAINING LOOP: an override without a reason is a lost training pair.
  // Accepting the AI price (overridden:false) IS the positive signal and needs
  // no reason.
  if (overridden && !reason) {
    throw err(400, "A reason is required when you override the AI's suggested price");
  }

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

  const description = body.description !== undefined ? String(body.description) : draft.draft.description;
  const tags = Array.isArray(body.tags) ? body.tags : draft.draft.tags || [];
  const included = Array.isArray(body.included) ? body.included : draft.draft.included || [];
  const unit = String(body.unit || draft.draft.unit || "").trim() || (await unitFor(category));
  const measurements = body.measurements || draft.draft.measurements || {};

  // The published price is exactly what the human approved — ONE tier row,
  // named from the category's applicable ladder. The full AI ladder stays on
  // the draft (immutably) for the training loop; we never re-derive prices the
  // approver did not see.
  const tiers = CATEGORY_TIERS[category];
  const tierName = TIER_LABEL[(tiers && tiers[0]) || "flat"] || "Price";

  const decorDoc = {
    category,
    name,
    unit,
    description,
    tags,
    image: draft.storedImage || "",
    thumbnail: draft.storedImage || "",
    productVisibility: false, // published into the store, not yet switched on
    productAvailability: false,
    productTypes: [{ name: tierName, costPrice: 0, sellingPrice: finalPrice, discount: 0 }],
    productInfo: {
      id: productCode,
      included,
      measurements: {
        length: Number(measurements.length) || 0,
        width: Number(measurements.width) || 0,
        height: Number(measurements.height) || 0,
        area: Number(measurements.area) || 0,
        radius: Number(measurements.radius) || 0,
        other: String(measurements.other || ""),
      },
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
  draft.pricing.finalPrice = finalPrice;
  draft.pricing.overridden = overridden;
  draft.pricing.reason = reason;
  draft.pricing.decidedBy = actorId || null;
  draft.pricing.decidedAt = new Date();
  draft.status = "approved";
  draft.publishedDecorId = created._id;
  draft.history.push({
    action: "approved",
    by: actorId || null,
    at: new Date(),
    note: overridden ? `price overridden: ${reason}` : "accepted the AI price",
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
  runPricingBrain,
  priceFromAnalysis,
  __deps: deps, // test seam
};

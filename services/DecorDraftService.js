const mongoose = require("mongoose");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const { suggestProductCode, isCodeTaken } = require("../utils/decorCode");
const { storeRemoteImage, toAnalysisBase64 } = require("../utils/remoteImageToS3");
const { analyseImage } = require("./decorVision");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("./decorPricing");
const { analyseListing } = require("./decorListing");

const err = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// ── Dedupe key ───────────────────────────────────────────────────────────────
// pinId wins when the extension supplies one. Otherwise we match on a
// NORMALISED image URL: Pinterest serves the same asset at many sizes
// (/236x/, /564x/, /originals/), so the stable identity is the trailing
// hash path (ab/cd/<hash>.jpg), not the full URL.
const normalizeImageUrl = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return s.toLowerCase();
  }
  const host = u.hostname.toLowerCase();
  let path = u.pathname.toLowerCase();
  if (/pinimg\.com$/.test(host)) {
    // drop the size segment: /564x/ab/cd/hash.jpg -> /ab/cd/hash.jpg
    path = path.replace(/^\/(originals|\d+x\d*)\//, "/");
    return `pinimg${path}`;
  }
  return `${host}${path}`;
};

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

// Brain 2: vision + pricing. Mirrors POST /decor/analyse-image, but keeps the
// FULL result (shapeClientResponse trims the wire response, not this).
const runPricingBrain = async (imageBase64) => {
  const analysis = await analyseImage({ imageBase64, mode: "full" });

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

// Injection seam so the test suite never calls Anthropic or S3.
const deps = {
  storeRemoteImage,
  toAnalysisBase64,
  runPricingBrain,
  analyseListing,
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

  if (!pricingBrain) {
    const b64 = await deps.toAnalysisBase64(stored.buffer);
    pricingBrain = await deps.runPricingBrain(b64);
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
    pricing: { aiSuggested: priceLadder },
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
  __deps: deps, // test seam
};

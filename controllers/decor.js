const Decor = require("../models/Decor");
const Attribute = require("../models/Attribute");
const Anthropic = require("@anthropic-ai/sdk");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("../services/decorPricing");
const { analyseImage, includedFor } = require("../services/decorVision");
const { buildDemoPrice, pinTextCategoryCheck, demoCategoryTiers, resolveOccasion } = require("../services/decorDemoPrice");
const sharp = require("sharp");

// Downscale a base64 or URL image before the vision call — cuts tokens/latency
// (demo needs < 3s). EXIF-corrected, aspect-preserved, max 800px longest edge.
const DEMO_MAX_EDGE = Number(process.env.DEMO_IMAGE_MAX_EDGE) || 800;
const downscaleToBase64 = async ({ imageBase64, imageUrl }) => {
  let buf;
  if (imageUrl) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`could not fetch image (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const m = /^data:[^;]+;base64,(.+)$/.exec(imageBase64 || "");
    buf = Buffer.from(m ? m[1] : imageBase64 || "", "base64");
  }
  const out = await sharp(buf, { failOn: "none" })
    .rotate()
    .resize({ width: DEMO_MAX_EDGE, height: DEMO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return out.toString("base64");
};

// Confidence gates for the vision → pricing handoff (env-overridable). Below a
// gate we drop the low-confidence signal and fall back to the category band,
// reporting each fallback in the response.
// ⚠️ Calibration note (2026-08, Sonnet 5 switch): these three gate the DRAFT
// path (/decor/analyse-image), not the live demo panel, and were tuned on
// Haiku's confidence scale. Sonnet reports measurement confidence ~30-40
// points lower than Haiku did for BETTER measurements, so SIZE_CONF_MIN in
// particular is likely too strict now — but no Sonnet distribution has been
// collected for size/complexity confidence specifically, so they are left at
// their defaults (env-overridable) rather than guessed. Recalibrate from real
// data before the draft path goes live. The demo-panel gates live in
// services/decorDemoPrice.js and WERE recalibrated.
const CATEGORY_CONF_MIN = Number(process.env.DECOR_VISION_CATEGORY_CONF_MIN) || 0.5;
const SIZE_CONF_MIN = Number(process.env.DECOR_VISION_SIZE_CONF_MIN) || 0.5;
const COMPLEXITY_CONF_MIN = Number(process.env.DECOR_VISION_COMPLEXITY_CONF_MIN) || 0.5;

const stripJsonFence = (text = "") =>
  String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

const parseImageDataUri = (input) => {
  if (typeof input !== "string") return null;
  const m = /^data:([^;]+);base64,(.+)$/.exec(input);
  if (m) return { mediaType: m[1], data: m[2] };
  return { mediaType: "image/jpeg", data: input };
};

// Translate Anthropic SDK errors → admin-friendly response.
const sendAnthropicError = (res, err, label) => {
  console.error(`[${label}] Anthropic call failed:`, {
    name: err?.name,
    status: err?.status,
    message: err?.message,
    error: err?.error,
  });
  const status = err?.status;
  const text = String(err?.message || "").toLowerCase();
  const isAuthOrBilling =
    status === 401 ||
    status === 402 ||
    status === 403 ||
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("api key") ||
    text.includes("invalid x-api-key") ||
    text.includes("authentication");
  if (isAuthOrBilling) {
    return res.status(502).send({
      message: "AI service error: Please check API credits or key",
      error: err?.message || String(err),
      status,
    });
  }
  if (status === 429) {
    return res.status(502).send({
      message: "AI service is rate-limited. Please try again in a moment.",
      error: err?.message || String(err),
      status,
    });
  }
  if (err?.name === "APIConnectionError" || text.includes("network")) {
    return res.status(502).send({
      message: "Could not reach AI service. Check network and try again.",
      error: err?.message || String(err),
    });
  }
  return res.status(502).send({
    message: "AI service error",
    error: err?.message || String(err),
    status: status || 500,
  });
};

// Shared 409 body for a product-code collision (used by CreateNew and by the
// A2S approve path via DecorDraftService).
const duplicateCodeResponse = (code) => ({
  message: "duplicate",
  field: "productInfo.id",
  detail: `Product code "${code}" is already in use. Pick another.`,
});

const CreateNew = async (req, res) => {
  const {
    category,
    label,
    rating,
    productVisibility,
    productAvailability,
    name,
    unit,
    tags,
    additionalImages,
    image,
    thumbnail,
    video,
    description,
    pdf,
    attributes,
    productVariation,
    productTypes,
    productVariants,
    productInfo,
    seoTags,
    rawMaterials,
    productAddOns,
  } = req.body;
  if (!name || !category) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    // July P0 fix: `checkId` on GET /decor is advisory only (and racy) — this
    // is the real server-side guard. The partial unique index behind it is the
    // backstop that closes the race; the E11000 catch below reports it.
    const requestedCode = productInfo && productInfo.id ? String(productInfo.id).trim() : "";
    if (requestedCode) {
      try {
        if (await Decor.exists({ "productInfo.id": requestedCode })) {
          return res.status(409).send(duplicateCodeResponse(requestedCode));
        }
      } catch (error) {
        return res.status(400).send({ message: "error", error });
      }
    }
    new Decor({
      category,
      label,
      rating,
      productVisibility,
      productAvailability,
      name,
      unit,
      tags,
      additionalImages,
      image,
      thumbnail,
      video,
      description,
      pdf,
      attributes,
      productVariation,
      productTypes,
      productVariants,
      productInfo,
      seoTags,
      rawMaterials,
      productAddOns,
    })
      .save()
      .then((result) => {
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        // Lost the race against a concurrent create with the same code.
        if (error && error.code === 11000) {
          return res.status(409).send(duplicateCodeResponse(requestedCode));
        }
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const {
    category,
    occassion,
    color,
    style,
    search,
    sort,
    stageSizeLower,
    stageSizeHigher,
    stageLengthLower,
    stageLengthHigher,
    stageWidthLower,
    stageWidthHigher,
    stageHeightLower,
    stageHeightHigher,
    priceLower,
    priceHigher,
    checkId,
    getLastIdFor,
    label,
    spotlight,
    searchFor,
    decorId,
    random,
    similarDecorFor,
    repeat,
    displayVisible,
    displayAvailable,
    productVisibility,
    productAvailability,
  } = req.query;
  if (checkId) {
    Decor.find({ "productInfo.id": checkId })
      .then((result) => {
        res.send({ id: checkId, isValid: !Boolean(result.length) });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (getLastIdFor) {
    Decor.find({ category: getLastIdFor })
      .sort({ "productInfo.id": -1 })
      .then((result) => {
        res.send({ id: result[0].productInfo.id, category: getLastIdFor });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (searchFor === "decorId") {
    Decor.find({ "productInfo.id": { $regex: new RegExp(decorId, "i") } })
      .limit(limit)
      .exec()
      .then((result) => {
        res.send({ list: result });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (spotlight === "true" && random === "true") {
    Decor.aggregate([{ $match: { spotlight: true } }, { $sample: { size: 1 } }])
      .then((result) => {
        res.send({ decor: result[0] });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (spotlight === "true" && random === "false") {
    Decor.aggregate([
      { $match: { spotlight: true } },
      { $addFields: { __curOrd: { $ifNull: ["$spotlightOrder", Number.MAX_SAFE_INTEGER] } } },
      { $sort: { __curOrd: 1, createdAt: -1 } },
      { $project: { __curOrd: 0 } },
    ])
      .then((result) => {
        res.send({ list: result });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (similarDecorFor) {
    // Build match query - exclude current decor and filter by category if provided
    const matchQuery = {
      _id: { $ne: similarDecorFor },
    };
    
    // Add category filter if category parameter is provided
    if (category) {
      matchQuery.category = category;
    }
    
    Decor.aggregate([
      {
        $match: matchQuery,
      },
      // {
      //   $project: {
      //     _id: 1,
      //     category: 1,
      //     tags: 1,
      //     occassion: "$productVariation.occassion",
      //     flowers: "$productVariation.flowers",
      //   },
      // },
      // {
      //   $group: {
      //     _id: null,
      //     products: {
      //       $push: {
      //         _id: "$_id",
      //         category: "$category",
      //         tags: "$tags",
      //         occassion: "$occassion",
      //         flowers: "$flowers",
      //       },
      //     },
      //   },
      // },
      // { $unwind: "$products" }, // Unwind to flatten the array
      // { $replaceRoot: { newRoot: "$products" } },
      // { $limit: 10 },
      { $sample: { size: 10 } },
      {
        $project: {
          _id: 1,
          category: 1,
          tags: 1,
          "productVariation.occassion": 1,
          "productVariation.flowers": 1,
        },
      },
      { $limit: 10 },
    ])
      .then((result) => {
        Decor.find({ _id: { $in: result.map((item) => item._id) } })
          .then((result) => res.send({ list: result }))
          .catch((error) => res.status(400).send({ message: "error", error }));
      })
      .catch((error) => res.status(400).send({ message: "error", error }));
  } else {
    const query = {};
    const sortQuery = {};
    if (label) {
      query.label = label;
    }
    if (spotlight === "true") {
      query.spotlight = true;
    }
    if (category) {
      query.category = category;
    }
    if (displayVisible === "true") {
      query.productVisibility = true;
    }
    if (displayAvailable === "true") {
      query.productAvailability = true;
    }
    if (productVisibility === "true") {
      query.productVisibility = true;
    } else if (productVisibility === "false") {
      query.productVisibility = false;
    }
    if (productAvailability === "true") {
      query.productAvailability = true;
    } else if (productAvailability === "false") {
      query.productAvailability = false;
    }
    if (search) {
      query.$or = [
        { name: { $regex: new RegExp(search, "i") } },
        // { description: { $regex: new RegExp(search, "i") } },
        { tags: { $regex: new RegExp(search, "i") } },
        { "productInfo.included": { $regex: new RegExp(search, "i") } },
        { "productInfo.id": { $regex: new RegExp(search, "i") } },
      ];
    }
    // Stage Size Filters
    if (!stageSizeLower && stageSizeHigher) {
      query.$expr = {
        $and: [
          {
            $gte: [
              {
                $multiply: [
                  "$productInfo.measurements.length",
                  "$productInfo.measurements.width",
                ],
              },
              stageSizeLower,
            ],
          },
          {
            $lte: [
              {
                $multiply: [
                  "$productInfo.measurements.length",
                  "$productInfo.measurements.width",
                ],
              },
              stageSizeHigher,
            ],
          },
        ],
      };
    }
    if (stageLengthLower && stageLengthHigher) {
      query["productInfo.measurements.length"] = {
        $gte: parseInt(stageLengthLower),
        $lte: parseInt(stageLengthHigher),
      };
    }
    if (stageWidthLower && stageWidthHigher) {
      query["productInfo.measurements.width"] = {
        $gte: parseInt(stageWidthLower),
        $lte: parseInt(stageWidthHigher),
      };
    }
    if (stageHeightLower && stageHeightHigher) {
      query["productInfo.measurements.height"] = {
        $gte: parseInt(stageHeightLower),
        $lte: parseInt(stageHeightHigher),
      };
    }
    if (occassion) {
      query["productVariation.occassion"] = {
        $in: occassion.split("|").map((i) => new RegExp(i, "i")),
      };
    }
    if (color) {
      query["productVariation.colors"] = {
        $in: color.split("|").map((i) => new RegExp(i, "i")),
      };
    }
    if (style && style !== "Both") {
      query["productVariation.style"] = style;
    }
    if (priceLower && priceHigher) {
      query["productTypes.sellingPrice"] = {
        $gte: priceLower,
        $lte: priceHigher,
      };
    }
    if (sort) {
      if (sort === "Price:Low-to-High") {
        sortQuery["productTypes.sellingPrice"] = 1;
      } else if (sort === "Price:High-to-Low") {
        sortQuery["productTypes.sellingPrice"] = -1;
      } else if (sort === "Newest-First") {
        sortQuery["createdAt"] = -1;
      } else if (sort === "Oldest-First") {
        sortQuery["createdAt"] = 1;
      } else if (sort === "Alphabetical:A-to-Z") {
        sortQuery["name"] = 1;
      } else if (sort === "Alphabetical:Z-to-A") {
        sortQuery["name"] = -1;
      }
    }
    Decor.countDocuments(query)
      .then((total) => {
        let totalPages = Math.ceil(total / limit);
        let validPage = page;
        validPage = validPage < 1 ? 1 : validPage;
        if (repeat !== "false") {
          validPage = ((page - 1 + totalPages) % totalPages) + 1;
        }
        let skip = (validPage - 1) * limit;
        // S3 — curated collections (bestSeller/popular label + spotlight) sort
        // by their order field when set, createdAt fallback; ordered items
        // first, unordered after. Only when the caller sent no explicit ?sort.
        const curatedField =
          !sort && spotlight === "true"
            ? "spotlightOrder"
            : !sort && label === "bestSeller"
              ? "bestSellerOrder"
              : !sort && label === "popular"
                ? "popularOrder"
                : null;
        const listQuery = curatedField
          ? Decor.aggregate([
              { $match: query },
              { $addFields: { __curOrd: { $ifNull: [`$${curatedField}`, Number.MAX_SAFE_INTEGER] } } },
              { $sort: { __curOrd: 1, createdAt: -1 } },
              { $skip: skip },
              { $limit: limit },
              { $project: { __curOrd: 0 } },
            ])
          : Decor.find(query).sort(sortQuery).skip(skip).limit(limit).exec();
        listQuery
          .then((result) => {
            res.send({ list: result, totalPages, page, limit });
          })
          .catch((error) => {
            res.status(400).send({
              message: "error",
              error,
            });
          });
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  }
};

// S3 — PUT /decor/reorder { collection: bestSeller|popular|spotlight,
// ids: [ordered] }: bulk $set of the collection's order field (1-based by
// array position). Admin-gated at the route. Ids outside the collection still
// get ranks — harmless, the reads filter by label/spotlight first.
const Reorder = (req, res) => {
  const { collection, ids } = req.body || {};
  const FIELD = { bestSeller: "bestSellerOrder", popular: "popularOrder", spotlight: "spotlightOrder" };
  const field = FIELD[collection];
  if (!field || !Array.isArray(ids) || !ids.length) {
    return res.status(400).send({ message: 'Pass collection ("bestSeller"|"popular"|"spotlight") and a non-empty ids array' });
  }
  const mongoose = require("mongoose");
  if (!ids.every((id) => mongoose.Types.ObjectId.isValid(String(id)))) {
    return res.status(400).send({ message: "ids must all be valid object ids" });
  }
  Decor.bulkWrite(
    ids.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { [field]: i + 1 } } },
    }))
  )
    .then((r) => res.status(200).send({ message: "success", ordered: ids.length, matched: r.matchedCount }))
    .catch((error) => res.status(400).send({ message: "error", error }));
};

const Get = (req, res) => {
  const { _id } = req.params;
  const { displayVisible, displayAvailable, populate } = req.query;
  if (populate) {
    Decor.findById({ _id })
      .populate(populate)
      .exec()
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send(result);
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    Decor.findById({ _id })
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send(result);
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { addTo, removeFrom, updateKey } = req.query;
  if (updateKey && updateKey === "productAvailability") {
    const { productAvailability } = req.body;
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          productAvailability,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (updateKey && updateKey === "productVisibility") {
    const { productVisibility } = req.body;
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          productVisibility,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (updateKey && updateKey === "label") {
    const { label } = req.body;
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          label,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (addTo === "spotlight") {
    const { spotlightColor, order } = req.body;
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          spotlight: true,
          spotlightColor,
          // S3 — optional curation rank inside the spotlight collection.
          ...(Number.isFinite(Number(order)) ? { spotlightOrder: Number(order) } : {}),
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (removeFrom === "spotlight") {
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          spotlight: false,
          spotlightOrder: null,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (addTo === "bestSeller" || addTo === "popular") {
    const { order } = req.body || {};
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          label: addTo,
          // S3 — optional curation rank inside the label collection.
          ...(Number.isFinite(Number(order))
            ? { [addTo === "bestSeller" ? "bestSellerOrder" : "popularOrder"]: Number(order) }
            : {}),
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (removeFrom === "bestSeller" || removeFrom === "popular") {
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          label: "",
          [removeFrom === "bestSeller" ? "bestSellerOrder" : "popularOrder"]: null,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    const {
      category,
      label,
      rating,
      productVisibility,
      productAvailability,
      name,
      unit,
      tags,
      additionalImages,
      image,
      thumbnail,
      video,
      description,
      pdf,
      attributes,
      productVariation,
      productTypes,
      productVariants,
      productInfo,
      seoTags,
      rawMaterials,
      productAddOns,
    } = req.body;
    if (!name || !category) {
      res.status(400).send({ message: "Incomplete Data" });
    } else {
      Decor.findByIdAndUpdate(
        { _id },
        {
          $set: {
            category,
            label,
            rating,
            productVisibility,
            productAvailability,
            name,
            unit,
            tags,
            additionalImages,
            image,
            thumbnail,
            video,
            description,
            pdf,
            attributes,
            productVariation,
            productTypes,
            productVariants,
            productInfo,
            seoTags,
            rawMaterials,
            productAddOns,
          },
        }
      )
        .then((result) => {
          if (result) {
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  }
};

const Delete = (req, res) => {
  const { _id } = req.params;
  Decor.findByIdAndDelete({ _id })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

// ─── Phase A — décor price suggestion ────────────────────────────────────────
// POST /decor/suggest-price  { category, size?|length?/width?|area?, style?, source? }
// Read-only: pulls same-category comparables from `decors` (productTypes only —
// never productInfo.variant) and runs the pure engine in services/decorPricing.
// Always returns observedBand + comparables next to `suggested`.
const SuggestPrice = (req, res) => {
  const { category } = req.body || {};
  if (!category) {
    return res.status(400).send({ message: "category is required" });
  }
  Decor.find(
    { category },
    "name productInfo.id productInfo.measurements productTypes"
  )
    .lean()
    .then((docs) => {
      const comparables = docs.map(normalizeComparable);
      let result;
      try {
        result = suggestPrice(req.body, comparables);
      } catch (e) {
        if (e && e.code === "UNKNOWN_CATEGORY") {
          return res.status(400).send({ message: e.message });
        }
        throw e;
      }
      res.status(200).send(result);
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

// ─── Client response shaping — the pricing METHOD never leaves the server ────
// The vision/demo SERVICES stay fully expressive: rates, multipliers, thresholds
// and derivation prose all remain on the returned object, so internal callers
// (A2S Phase C, admin views) and the engine's own tests keep reading everything.
// This serializer is the ONLY thing that reaches the wire, and it trims the
// payload to operational outputs — a saved response must not be enough to
// reverse-derive the pricing engine.
//
// STRIPPED (method): every rate constant (*RatePerFt / ratePerSqFt), tier
// ladders and divisors, the uplift and headroom multipliers, the structure
// threshold and its floral/structure split, pricingModel, the reference anchor,
// observedBand percentiles, occasion source internals, numeric confidence gates,
// comparables' per-tier prices, and ALL derivation prose.
// TRANSFORMED: method-revealing signals become operational booleans —
// confirmWidth (staff must verify the width before quoting), structureHeavy
// (limited negotiating margin, without saying what triggered it), lowConfidence.
// KEPT: the outputs staff actually work from — category, observations, measured
// VALUES, the price ladder, and the corrections loop (repeatingElements lets
// staff say "those panels are 12 ft"; an occasion conflict warns that the
// caption and the image disagree).

// Width at or under which staff need not re-measure. Deliberately NOT the
// structure threshold — this is a "go confirm it" prompt, not a pricing edge.
const CONFIRM_WIDTH_FT = 25;
// Defensive net: any key whose value narrates HOW a number was produced, at any
// depth, is dropped after shaping — so a service that later adds nested prose
// can never leak it through a field this serializer forwards wholesale.
const PROSE_KEYS = new Set(["reasoning"]);
const deepStripProse = (value) => {
  if (Array.isArray(value)) return value.map(deepStripProse);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PROSE_KEYS.has(k)) continue;
      out[k] = deepStripProse(v);
    }
    return out;
  }
  return value;
};

// Measurements: the NUMBERS staff read and correct — never the derivation.
// repeatingElements survives because the correction loop is the point; the
// basis label, the competing span, the scene/geometry inputs, the pre-snap raw
// height, the ratio divisor, the coverage fraction and the prose do not.
const shapeMeasurements = (m) => {
  if (!m) return null;
  const out = {};
  if (m.backdropWidthFt != null) out.backdropWidthFt = m.backdropWidthFt;
  if (m.estimatedHeightFt != null) out.estimatedHeightFt = m.estimatedHeightFt;
  if (m.floralRunFt != null) out.floralRunFt = m.floralRunFt;
  const re = m.repeatingElements;
  if (re && re.count != null && re.estimatedWidthEachFt != null) {
    out.repeatingElements = { count: re.count, estimatedWidthEachFt: re.estimatedWidthEachFt };
  }
  return out;
};
// Raw confidence is stripped, so this boolean carries the whole "verify it" job.
const needsWidthConfirm = (m) =>
  !!m && (Number(m.backdropWidthFt) > CONFIRM_WIDTH_FT || m.lowConfidence === true);
// The detected occasion and — operationally — that the caption and the image
// disagreed. The source ranking and the stage-rate default stay server-side.
const shapeOccasion = (o) => ({
  value: o.value != null ? o.value : null,
  ...(o.conflict ? { conflict: o.conflict } : {}),
});
// Examples are a "show me one" affordance: name, image and the size label. No
// product code, and no price — price-browsing belongs in OS, not this payload.
const shapeExample = (e) => ({
  ...(e.name != null ? { name: e.name } : {}),
  ...(e.image != null ? { image: e.image } : {}),
  ...(e.size != null ? { size: e.size } : {}),
});
// The ladder row keeps its size label and its tier→{low,high} prices. `area` is
// dropped: with the size already present it only feeds the area exponent.
const shapeLadderRow = (row) => ({
  size: row.size != null ? row.size : null,
  prices: row.prices || {},
  ...(row.examplesAtThisSize
    ? { examplesAtThisSize: (row.examplesAtThisSize || []).map(shapeExample) }
    : {}),
});

const shapeDemoPrice = (out) => {
  if (!out || typeof out !== "object") return out;
  // Rejections carry client-safe wording only.
  if (out.rejected) {
    return deepStripProse({
      rejected: true,
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.pinTextCheck ? { pinTextCheck: out.pinTextCheck } : {}),
    });
  }
  const m = out.stageMeasurements || null;
  return deepStripProse({
    rejected: false,
    category: out.category,
    categoryConfidence: out.categoryConfidence,
    observations: Array.isArray(out.observations) ? out.observations : [],
    ...(out.minBuildWidth && out.minBuildWidth.minWidthFt != null
      ? { minBuildWidth: { minWidthFt: out.minBuildWidth.minWidthFt } }
      : {}),
    ...(out.recommendedSize ? { recommendedSize: out.recommendedSize } : {}),
    ...(m ? { stageMeasurements: shapeMeasurements(m) } : {}),
    // Operational signals in place of the threshold / rate / split.
    // ── Presentation switch (2026-08-17), NOT pricing method ─────────────────
    // The panel gates five features on this: the measurement line, the
    // disputed-width warning, the confirm-the-size-with-the-client note (the
    // safeguard for the ±25% width read noise), the hint text, and the staff
    // floral-rate line. All five were dead because they had been gated on
    // `pricingModel`, which is correctly stripped here as pricing METHOD.
    // This boolean is the presentation half of that signal with none of the
    // method: no rate, no multiplier, no model name. The panel CANNOT derive it
    // from `stageMeasurements`, which is emitted for any category regardless of
    // how the build was priced — see the note at its source.
    floralRunPriced: !!out.floralRunPriced,
    // Keyed on `fabricated`, NOT `applies`. Since 2026-08-17 a sub-30ft build
    // also carries a (light) structure charge, so `applies` is true for almost
    // every Stage. This flag has to keep meaning "limited negotiating margin on
    // a build fabricated from scratch" — gate it on the ≥30ft band only.
    structureHeavy: !!(out.structure && out.structure.fabricated),
    confirmWidth: needsWidthConfirm(m),
    lowConfidence: !!(m && m.lowConfidence),
    ...(out.occasion ? { occasion: shapeOccasion(out.occasion) } : {}),
    applicableTiers: out.applicableTiers,
    ladder: (out.ladder || []).map(shapeLadderRow),
    ...(out.pinTextCheck ? { pinTextCheck: out.pinTextCheck } : {}),
  });
};

// The vision analysis: descriptive output and measured values. `complexity` goes
// entirely — its tier is the ladder's band-position input — as does every
// confidence gate that decided whether a signal was used.
const shapeAnalysis = (a) => {
  if (!a || typeof a !== "object") return a;
  const m = a.stageMeasurements || null;
  return {
    isDecorProduct: a.isDecorProduct,
    category: a.category != null ? a.category : null,
    categoryConfidence: a.categoryConfidence,
    ...(a.style ? { style: a.style } : {}),
    ...(a.size && (a.size.length > 0 || a.size.width > 0)
      ? { size: { length: a.size.length, width: a.size.width } }
      : {}),
    ...(Array.isArray(a.observations) ? { observations: a.observations } : {}),
    ...(a.minBuildWidth && a.minBuildWidth.minWidthFt != null
      ? { minBuildWidth: { minWidthFt: a.minBuildWidth.minWidthFt } }
      : {}),
    ...(a.recommendedSize ? { recommendedSize: a.recommendedSize } : {}),
    ...(m ? { stageMeasurements: shapeMeasurements(m) } : {}),
    ...(a.occasion ? { occasion: shapeOccasion(a.occasion) } : {}),
    // Listing copy (full mode) — descriptive, carries no pricing method.
    ...(a.flowers ? { flowers: a.flowers } : {}),
    ...(a.colors ? { colors: a.colors } : {}),
    ...(a.fabric ? { fabric: a.fabric } : {}),
    ...(a.suggestedName ? { suggestedName: a.suggestedName } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.tags ? { tags: a.tags } : {}),
    ...(a.included ? { included: a.included } : {}),
  };
};
// The priced outputs only: the band percentiles, the uplift, the size-exponent
// basis, the complexity factor and the comparables table never ship.
const shapePricing = (p) => {
  if (!p || typeof p !== "object") return null;
  return {
    category: p.category,
    applicableTiers: p.applicableTiers,
    ...(p.suggested != null ? { suggested: p.suggested } : {}),
    ...(p.suggestedBand ? { suggestedBand: p.suggestedBand } : {}),
    ...(p.priceRange ? { priceRange: p.priceRange } : {}),
  };
};
// `fallbacks[]` narrated which gate fired AND printed its value; it collapses to
// one boolean meaning "degraded — verify before quoting".
const shapeAnalyseImage = (payload = {}) => {
  const { analysis, pricing, fallbacks, rejected } = payload;
  const m = analysis && analysis.stageMeasurements;
  return deepStripProse({
    analysis: shapeAnalysis(analysis),
    pricing: shapePricing(pricing),
    ...(rejected ? { rejected: true } : {}),
    lowConfidence: (Array.isArray(fallbacks) && fallbacks.length > 0) || !!(m && m.lowConfidence),
    confirmWidth: needsWidthConfirm(m),
  });
};

// The single boundary every décor AI response passes through.
const shapeClientResponse = (kind, payload) =>
  kind === "demo-price" ? shapeDemoPrice(payload) : shapeAnalyseImage(payload);

// ─── Phase B — vision layer ──────────────────────────────────────────────────
// POST /decor/analyse-image  { imageBase64? | imageUrl? | image?, source? }
// Read-only. Runs the vision model, then the Phase A engine on VISIBLE +
// AVAILABLE comparables only (demo panel must not show unbuyable items), wiring
// the complexity tier into band position. Low-confidence signals are dropped and
// reported under `fallbacks` (fall back to the category median, and say so).
const AnalyseImage = async (req, res) => {
  const { imageBase64, imageUrl, image, source, mode } = req.body || {};
  const b64 = imageBase64 || (typeof image === "string" && !/^https?:\/\//i.test(image) ? image : undefined);
  const url = imageUrl || (typeof image === "string" && /^https?:\/\//i.test(image) ? image : undefined);
  if (!b64 && !url) {
    return res.status(400).send({ message: "image (base64) or imageUrl is required" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).send({ message: "ANTHROPIC_API_KEY not configured" });
  }

  let analysis;
  try {
    analysis = await analyseImage({
      imageBase64: b64,
      imageUrl: url,
      mode: mode === "demo" ? "demo" : "full",
    });
  } catch (apiErr) {
    if (apiErr && apiErr.code === "VISION_PARSE") {
      return res.status(502).send({
        message: "AI returned an unexpected response format",
        raw: apiErr.raw,
      });
    }
    return sendAnthropicError(res, apiErr, "AnalyseImage");
  }

  // Rejection escape hatch: not a décor product → no pricing, no comparables.
  if (!analysis.isDecorProduct) {
    return res.status(200).send(shapeClientResponse("analyse-image", { analysis, pricing: null, rejected: true }));
  }

  const cat = analysis.category;
  const applicable = CATEGORY_TIERS[cat];
  const fallbacks = [];

  if (analysis.categoryConfidence < CATEGORY_CONF_MIN) {
    fallbacks.push(`category: low confidence (${analysis.categoryConfidence})`);
  }

  // Size feeds pricing only for Stage/Mandap AND only when confident.
  const sizeConf = analysis.size ? analysis.size.confidence : 0;
  const sizeIsSized = cat === "Stage" || cat === "Mandap";
  const useSize = sizeIsSized && sizeConf >= SIZE_CONF_MIN;
  if (sizeIsSized && !useSize) {
    fallbacks.push(
      `size: low confidence (${sizeConf}) — ignored, using the category band (median)`
    );
  }

  // Complexity places the price within the band; low confidence → standard.
  const cxConf = analysis.complexity ? analysis.complexity.confidence : 0;
  const useComplexity = cxConf >= COMPLEXITY_CONF_MIN;
  const complexityTier = useComplexity ? analysis.complexity.tier : "standard";
  if (!useComplexity) {
    fallbacks.push(
      `complexity: low confidence (${cxConf}) — defaulted to standard (median)`
    );
  }

  // Style only applies to Stage and only when the model committed to one.
  const style = cat === "Stage" && (analysis.style === "Modern" || analysis.style === "Traditional")
    ? analysis.style
    : undefined;

  if (!applicable) {
    return res.status(200).send(shapeClientResponse("analyse-image", {
      analysis,
      pricing: null,
      fallbacks: [...fallbacks, `category "${cat}" is not in the pricing model — no price computed`],
    }));
  }

  try {
    // Demo/orderability filter: never surface an unbuyable comparable on a call.
    const docs = await Decor.find(
      { category: cat, productVisibility: true, productAvailability: true },
      "name productInfo.id productInfo.measurements productTypes image thumbnail"
    ).lean();
    const comparables = docs.map(normalizeComparable);

    const pricing = suggestPrice(
      {
        category: cat,
        length: useSize ? analysis.size.length : undefined,
        width: useSize ? analysis.size.width : undefined,
        style,
        complexity: complexityTier,
        source: source === "extension" ? "extension" : "internal",
        // demo → range instead of a complexity-adjusted point price
        mode: mode === "demo" ? "demo" : "full",
      },
      comparables
    );

    return res.status(200).send(shapeClientResponse("analyse-image", { analysis, pricing, fallbacks }));
  } catch (error) {
    return res.status(400).send({ message: "error", error });
  }
};

// ─── Demo panel — live client pricing ────────────────────────────────────────
// POST /decor/demo-price  { imageBase64? | imageUrl? | image?, pinText?,
//                           includeExamples?, categoryOverride? }
// Read-only. Vision (demo mode) → category; non-décor → { rejected }. Otherwise a
// category-aware PRICE LADDER (per size bucket for Stage/Mandap, one category-band
// row otherwise) from the Phase A engine. Raw prices, NO uplift. The size ladder
// exists so the human asks the client the size — the model's size is ignored.
// `categoryOverride` (a valid category name) SKIPS the vision call entirely and
// prices that category directly: the panel's staff dropdown must be instant, and
// a wrong category is a ~2× price error only the human on the call can fix.
const DemoPrice = async (req, res) => {
  const { imageBase64, imageUrl, image, pinText, includeExamples, categoryOverride, stageMeasurements } = req.body || {};

  let analysis;
  if (categoryOverride != null) {
    // demoCategoryTiers also admits demo-only categories (Haldi) that have no
    // catalog taxonomy entry.
    if (!demoCategoryTiers(categoryOverride)) {
      return res.status(400).send({ message: `Unknown décor category: ${JSON.stringify(categoryOverride)}` });
    }
    // Staff said what it is — no vision, so no confidence and no observations.
    // The panel may resend the earlier vision backdrop measurement so an
    // override TO Stage keeps floral-run pricing (buildDemoPrice validates it).
    analysis = {
      isDecorProduct: true,
      category: categoryOverride,
      categoryConfidence: null,
      observations: [],
      stageMeasurements: stageMeasurements || null,
    };
  } else {
    const b64 = imageBase64 || (typeof image === "string" && !/^https?:\/\//i.test(image) ? image : undefined);
    const url = imageUrl || (typeof image === "string" && /^https?:\/\//i.test(image) ? image : undefined);
    if (!b64 && !url) {
      return res.status(400).send({ message: "image (base64) or imageUrl is required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).send({ message: "ANTHROPIC_API_KEY not configured" });
    }

    // Downscale before the vision call. A read failure must not throw a stack
    // trace onto a live call — return a graceful message the panel can render.
    let downscaled;
    try {
      downscaled = await downscaleToBase64({ imageBase64: b64, imageUrl: url });
    } catch (e) {
      return res.status(502).send({ message: "Couldn't read this image — try another." });
    }

    try {
      analysis = await analyseImage({ imageBase64: downscaled, mode: "demo" });
    } catch (apiErr) {
      if (apiErr && apiErr.code === "VISION_PARSE") {
        return res.status(502).send({ message: "Couldn't read this image — try another." });
      }
      return sendAnthropicError(res, apiErr, "DemoPrice");
    }
  }

  const pinTextCheck = pinTextCategoryCheck(pinText, analysis.category);
  // Occasion (caption + vision) decides which pricing model applies (haldi has
  // its own rate). Deliberately NOT resolved on a category override — the
  // dropdown is the correction path and must never be re-flipped.
  const occasion = categoryOverride != null ? null : resolveOccasion(pinText, analysis.occasion);

  // Non-décor → reject, no pricing, no comparables.
  if (!analysis.isDecorProduct) {
    const out = buildDemoPrice(analysis, [], { includeExamples: false });
    return res.status(200).send(shapeClientResponse("demo-price", { ...out, ...(pinTextCheck ? { pinTextCheck } : {}) }));
  }

  try {
    // Examples + non-sized band prices come from ORDERABLE products only.
    const docs = await Decor.find(
      { category: analysis.category, productVisibility: true, productAvailability: true },
      "name productInfo.id productInfo.measurements productTypes image thumbnail"
    ).lean();
    const comparables = docs.map(normalizeComparable);
    const out = buildDemoPrice(analysis, comparables, { includeExamples: !!includeExamples, occasion });
    return res.status(200).send(shapeClientResponse("demo-price", { ...out, ...(pinTextCheck ? { pinTextCheck } : {}) }));
  } catch (error) {
    return res.status(400).send({ message: "error", error });
  }
};

// ─── AI listing helpers ──────────────────────────────────────────────────────

const AI_SYSTEM_PROMPT = `You are a luxury Indian wedding decor product naming expert. Analyze the uploaded product image carefully.

Detect: decor style (traditional Indian / modern contemporary / fusion), color palette, floral types, ambience, structure, lighting, occasions it suits.

NAMING RULES:
- Traditional/Indian aesthetic → royal, classic, cultural names (e.g. Ivory Grace, Regal Flora, Marigold Grandeur)
- Modern/contemporary aesthetic → sleek, premium, aesthetic names (e.g. Velvet Aura, Opal Pavilion, Celestial Bloom)
- Fusion → blend both styles
- STRICTLY 2 words (3 only if absolutely necessary)
- Must NOT be similar to any name in existing_names list
- Luxury Indian wedding catalog feel, non-generic, premium
- Avoid: color-only names, generic names, basic/local vendor-style names

ATTRIBUTE RULES:
- ONLY use values from attribute_options provided
- If unsure → return empty array, never invent values

TAGS RULES — also generate searchable tags for the 'tags' field by analyzing the image:
- Decor style tags (floral, royal, modern, traditional, fusion etc)
- Color tags (pink, gold, white, red etc)
- Occasion tags (wedding, reception, engagement etc)
- Structural tags (backdrop, arch, mandap, stage, canopy etc)
- Mood/aesthetic tags (romantic, grand, minimal, vibrant, elegant etc)
- Material tags if visible (fabric, fresh flowers, LED, mirror, drapes etc)

TAGS FORMAT:
- Short single or double word tags only
- 8-12 tags per product
- All lowercase
- Return as array of strings

Return ONLY valid JSON no markdown:
{
  name: string,
  description: string (2-3 sentences, luxury emotional language),
  seoKeywords: string[],
  category: string,
  style: string[],
  colors: string[],
  flowers: string[],
  occasions: string[],
  tags: string[],
  detectedAesthetic: 'traditional' | 'modern' | 'fusion'
}`;

const AiAnalyze = async (req, res) => {
  try {
    const { imageBase64, category } = req.body || {};
    if (!imageBase64 || !category) {
      return res
        .status(400)
        .send({ message: "imageBase64 and category are required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res
        .status(500)
        .send({ message: "ANTHROPIC_API_KEY not configured" });
    }

    const img = parseImageDataUri(imageBase64);
    if (!img) {
      return res.status(400).send({ message: "invalid imageBase64" });
    }

    const [existing, attrs] = await Promise.all([
      Decor.find({ category }, "name").lean(),
      Attribute.find({}, "name list").lean(),
    ]);
    const existingNames = existing.map((d) => d.name).filter(Boolean);
    const attributeOptions = {};
    attrs.forEach((a) => {
      attributeOptions[a.name] = a.list || [];
    });

    // ── 2026-08-17: this endpoint now runs the MERGED vision+listing brain in
    // "listing" mode (services/decorVision.js LISTING_SCHEMA_INSTR) instead of
    // its own weak autofill prompt. One image, one call, off the calibrated
    // brain. existing_names and attribute_options are still supplied
    // (category-scoped, as before), so the strict 2-word naming rule and the
    // don't-resemble-existing-names constraint are preserved verbatim.
    //
    // ⛔ "listing" mode is scoped to THIS endpoint only. It destabilises the
    // `style` read (st034: 5/8 Modern vs the current schema's 0/8), and style
    // drives STYLE_PREMIUM — a ±42% Stage price swing. /decor/analyse-image,
    // /decor/demo-price and the A2S draft path all stay on "full"/"demo", which
    // are unchanged. AI_SYSTEM_PROMPT below is retained because
    // services/decorListing.js (still used by A2S) imports it.
    let analysis;
    try {
      analysis = await analyseImage({
        imageBase64: img.data,
        mode: "listing",
        listingContext: { existingNames, attributeOptions },
      });
    } catch (apiErr) {
      if (apiErr && apiErr.code === "VISION_PARSE") {
        console.error("[AiAnalyze] JSON parse failed. Raw response:\n", apiErr.raw);
        return res.status(502).send({
          message: "AI returned an unexpected response format",
          raw: apiErr.raw,
        });
      }
      return sendAnthropicError(res, apiErr, "AiAnalyze");
    }

    // RESPONSE CONTRACT PRESERVED — the admin catalogue form reads these keys.
    // `style` stays an ARRAY for the FE, built from the ONE scalar judgement:
    // the catalogue's Attribute "Style" list is exactly ["Modern","Traditional"],
    // so the scalar IS the attribute value and there is no second style field.
    // `category` echoes the request, as it always did; `included` is derived from
    // it by the same rule as before. Everything after `included` is NEW — the
    // upgrade this surface gets from running on the calibrated brain.
    return res.send({
      name: analysis.name || "",
      description: analysis.description || "",
      seoKeywords: analysis.seoKeywords || [],
      category,
      style: analysis.style ? [analysis.style] : [],
      colors: analysis.colors || [],
      flowers: analysis.flowers || [],
      occasions: analysis.occasions || [],
      tags: analysis.tags || [],
      detectedAesthetic: analysis.detectedAesthetic || null,
      included: includedFor(category),
      // NEW (additive — the FE can ignore these safely):
      fabric: analysis.fabric || [],
      detectedCategory: analysis.category || null,
      categoryConfidence: analysis.categoryConfidence,
      size: analysis.size || null,
      complexity: analysis.complexity || null,
    });
  } catch (err) {
    console.error("AiAnalyze error:", err?.message || err);
    return res
      .status(500)
      .send({ message: "ai_analyze_failed", error: err?.message || String(err) });
  }
};

const AiRegenerate = async (req, res) => {
  try {
    const { currentAttributes } = req.body || {};
    if (!currentAttributes || typeof currentAttributes !== "object") {
      return res.status(400).send({ message: "currentAttributes is required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res
        .status(500)
        .send({ message: "ANTHROPIC_API_KEY not configured" });
    }

    const category = currentAttributes.category || "";
    const existing = category
      ? await Decor.find({ category }, "name").lean()
      : [];
    const existingNames = existing.map((d) => d.name).filter(Boolean);

    const userText = `Based ONLY on these manually selected attributes, generate a new luxury name and description.
Do NOT imagine from any image.

Attributes: ${JSON.stringify(currentAttributes)}
Existing names to avoid: ${JSON.stringify(existingNames)}

NAMING RULES:
- style array determines aesthetic: Traditional → royal/cultural, Modern → sleek/aesthetic
- STRICTLY 2 words (3 only if necessary)
- Must NOT be similar to existing names
- Luxury Indian wedding catalog feel

Return ONLY valid JSON:
{ name: string, description: string, seoKeywords: string[] }`;

    let message;
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      message = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 512,
        messages: [{ role: "user", content: userText }],
      });
    } catch (apiErr) {
      return sendAnthropicError(res, apiErr, "AiRegenerate");
    }

    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    try {
      const parsed = JSON.parse(stripJsonFence(text));
      return res.send(parsed);
    } catch (e) {
      console.error("[AiRegenerate] JSON parse failed. Raw response:\n", text);
      return res.status(502).send({
        message: "AI returned an unexpected response format",
        error: e?.message || String(e),
        raw: text,
      });
    }
  } catch (err) {
    console.error("AiRegenerate error:", err?.message || err);
    return res.status(500).send({
      message: "ai_regenerate_failed",
      error: err?.message || String(err),
    });
  }
};

module.exports = {
  CreateNew, GetAll, Get, Update, Delete, AiAnalyze, AiRegenerate, Reorder, SuggestPrice, AnalyseImage, DemoPrice,
  // exported for the response-contract test — the wire-shaping boundary
  shapeClientResponse, shapeDemoPrice, shapeAnalyseImage,
  // A2S: services/decorListing runs this same listing analysis off-HTTP for the
  // draft-create path. Shared (not copied) so the two can never drift.
  AI_SYSTEM_PROMPT,
};

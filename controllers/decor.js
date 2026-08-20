const Decor = require("../models/Decor");
const Attribute = require("../models/Attribute");
const Anthropic = require("@anthropic-ai/sdk");
const { suggestPrice, normalizeComparable, CATEGORY_TIERS } = require("../services/decorPricing");
const { analyseImage, includedFor } = require("../services/decorVision");
const { buildListingContext } = require("../services/decorListingContext");
const { buildDemoPrice, buildStorePrice, pinTextCategoryCheck, demoCategoryTiers, resolveOccasion } = require("../services/decorDemoPrice");
const readCache = require("../services/decorReadCache");
const DecorDraftService = require("../services/DecorDraftService");
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
      // From the AUTHENTICATED admin, never from the body — this is an
      // accountability record, so a caller must not be able to claim it was
      // someone else. (PUT /decor/:_id destructures an explicit allowlist that
      // does not include createdBy, so it cannot be rewritten later either.)
      createdBy: (req.auth && req.auth.user_id) || null,
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
    source,
    createdBy,
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
    // How the product was added — "extension" for A2S-published items. Plain
    // equality, matching `label`/`category` above. Manually-added products leave
    // the field UNSET, so they are not addressable by equality; see the note on
    // Decor.source.
    if (source) {
      query.source = source;
    }
    // Who published it. Plain equality on the admin's _id, matching `source` and
    // `category` above. Products predating createdBy match nothing here — that
    // is correct, but it means this filter hides them, so the catalogue should
    // offer an explicit "Unknown" option rather than leaving them unreachable.
    if (createdBy) {
      query.createdBy = createdBy;
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
  // createdBy is populated on BOTH branches so the details view always has the
  // name. The list (GetAll) deliberately returns the raw id instead: its curated
  // branch is an aggregate, which populate does not apply to, and one branch
  // returning a name while the other returns an id is a worse trap than a
  // consistent id the caller maps itself.
  if (populate) {
    Decor.findById({ _id })
      .populate(populate)
      .populate("createdBy", "name")
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
      .populate("createdBy", "name")
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
// A size option is a ladder row plus its concrete dimensions — the panel needs
// length/width to render the picker selection. `area` is DROPPED for the same
// reason shapeLadderRow drops it: with the size present it only feeds the area
// exponent, so it is method, not output. (The response-contract suite caught
// this — it is an asserted invariant, not a style preference.)
const shapeSizeOption = (o) => ({
  size: o.size != null ? o.size : null,
  length: o.length != null ? o.length : null,
  width: o.width != null ? o.width : null,
  prices: o.prices || {},
});
const shapeLadderRow = (row) => ({
  size: row.size != null ? row.size : null,
  prices: row.prices || {},
  ...(row.examplesAtThisSize
    ? { examplesAtThisSize: (row.examplesAtThisSize || []).map(shapeExample) }
    : {}),
});

// Read provenance, allowlisted like everything else on this wire. `product` is
// present only on a from-store reply — the panel says "this is our <code>"
// instead of quoting an estimate for something we already sell.
const shapeRead = (r) => ({
  origin: r.origin,
  ...(r.firstReadAt ? { firstReadAt: r.firstReadAt } : {}),
  ...(r.product
    ? {
        product: {
          ...(r.product.code ? { code: r.product.code } : {}),
          ...(r.product.name ? { name: r.product.name } : {}),
        },
      }
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
      // A rejection is a read too — say whether it was replayed, so re-checking
      // a non-décor photo doesn't look like a fresh (billed) verdict.
      ...(out.read ? { read: shapeRead(out.read) } : {}),
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
    // ── READ PROVENANCE (2026-08-17) — where this answer came from ───────────
    // fresh = the AI just looked at it · cached = a stored read was replayed, so
    // the number is identical to last time by construction · from-store = the pin
    // is already a published product and the human's price won. `firstReadAt`
    // lets the panel say "read on 14 Aug" instead of implying it is live.
    // Provenance, not pricing method: no rate, no multiplier, no model name.
    ...(out.read ? { read: shapeRead(out.read) } : {}),
    ...(out.occasion ? { occasion: shapeOccasion(out.occasion) } : {}),
    applicableTiers: out.applicableTiers,
    ladder: (out.ladder || []).map(shapeLadderRow),
    // ── Size bracket (additive 2026-08) — every key above is unchanged. ──────
    // Two valid rungs bracketing the read, each with its own full price ladder,
    // so staff pick a size instead of the pipeline betting on one draw at
    // temperature 1.0. Omitted entirely when empty, so a category with no size
    // model adds nothing to the payload.
    ...(Array.isArray(out.sizeOptions) && out.sizeOptions.length
      ? { sizeOptions: out.sizeOptions.map(shapeSizeOption) }
      : {}),
    // The full set of valid pairs, for a manual picker that can only offer real
    // sizes. No prices — the picker chooses a size, the ladder carries money.
    ...(Array.isArray(out.validSizes) && out.validSizes.length
      ? { validSizes: out.validSizes.map((s) => ({ size: s.size, length: s.length, width: s.width })) }
      : {}),
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
// ─────────────────────────────────────────────────────────────────────────────
// GET /decor/:_id/analysis — the AI analysis behind a published product.
//
// SAME TRIM DISCIPLINE as the other décor surfaces: an explicit allowlist, so a
// field added to the draft later cannot leak by default. Everything that would
// narrate HOW a price was produced is dropped — observedBand and its percentile
// machinery, the comparables table, sizeBasis, upliftApplied, bandPosition,
// headroom, rates and divisors. What survives is the JUDGEMENT and the outcome.
//
// ⚠️ ONE DELIBERATE DEPARTURE from shapeAnalysis: `complexity.reasoning` IS
// returned. shapeAnalysis strips complexity wholesale because there it is a
// pricing INPUT (the band-position lever) on a response the sales panel renders.
// Here the endpoint exists to show a human why the AI judged a build the way it
// did, and that sentence describes the BUILD, not the price — "heavy floral
// coverage across six bays" reveals no rate. The confidence GATES are still
// stripped, so what is shown is the judgement, never the machinery that weighed
// it.
const shapeAnalysisMeasurements = (m) => {
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (m.backdropWidthFt != null) out.backdropWidthFt = m.backdropWidthFt;
  if (m.estimatedHeightFt != null) out.estimatedHeightFt = m.estimatedHeightFt;
  if (m.floralRunFt != null) out.floralRunFt = m.floralRunFt;
  const re = m.repeatingElements;
  if (re && re.count != null && re.estimatedWidthEachFt != null) {
    out.repeatingElements = { count: re.count, estimatedWidthEachFt: re.estimatedWidthEachFt };
  }
  return Object.keys(out).length ? out : null;
};

const shapeDecorAnalysis = (draft) => {
  const ai = draft.aiAnalysis || {};
  const brain = ai.pricing || {};
  const a = brain.analysis || {};
  const copy = ai.listing && !ai.listing.error ? ai.listing : a;
  const ladder = brain.pricing || {};
  const decided = draft.pricing || {};
  const who = (v) => (v && typeof v === "object" && v.name ? { name: v.name } : null);

  return {
    draftId: String(draft._id),
    // ── the read ──────────────────────────────────────────────────────────
    category: a.category != null ? a.category : null,
    categoryConfidence: a.categoryConfidence != null ? a.categoryConfidence : null,
    ...(ai.categoryDisagreement ? { categoryDisagreement: ai.categoryDisagreement } : {}),
    style: a.style != null ? a.style : null,
    ...(a.complexity
      ? { complexity: { tier: a.complexity.tier || null, reasoning: a.complexity.reasoning || "" } }
      : {}),
    ...(a.size && (a.size.length > 0 || a.size.width > 0)
      ? { size: { length: a.size.length, width: a.size.width } }
      : {}),
    ...(a.recommendedSize ? { recommendedSize: a.recommendedSize } : {}),
    ...(a.occasion && a.occasion.value ? { occasion: { value: a.occasion.value } } : {}),
    ...(a.minBuildWidth && a.minBuildWidth.minWidthFt != null
      ? { minBuildWidth: { minWidthFt: a.minBuildWidth.minWidthFt } }
      : {}),
    observations: Array.isArray(a.observations) ? a.observations : [],
    measurements: shapeAnalysisMeasurements(a.stageMeasurements),

    // ── what the AI proposed ──────────────────────────────────────────────
    // The per-tier figures and which tiers applied. NOT observedBand, NOT the
    // comparables table, NOT sizeBasis or upliftApplied — those are the method.
    priceLadder: {
      applicableTiers: Array.isArray(ladder.applicableTiers) ? ladder.applicableTiers : [],
      suggested: ladder.suggested || {},
    },
    copy: {
      name: copy.suggestedName || copy.name || "",
      description: copy.description || "",
      tags: Array.isArray(copy.tags) ? copy.tags : [],
      colors: Array.isArray(copy.colors) ? copy.colors : [],
      flowers: Array.isArray(copy.flowers) ? copy.flowers : [],
      fabric: Array.isArray(copy.fabric) ? copy.fabric : [],
      included: Array.isArray(copy.included) ? copy.included : [],
    },

    // ── what the human did — the half that matters a year from now ────────
    decision: {
      approvedBy: who(decided.decidedBy),
      approvedAt: decided.decidedAt || null,
      // Dimension corrections sit ALONGSIDE the tier ones, never inside them —
      // see the note on DecorDraft.pricing.measurementDecisions for why mixing
      // the two would make a length row the product's price.
      measurementDecisions: (decided.measurementDecisions || []).map((m) => ({
        field: m.field,
        aiRead: m.aiRead != null ? m.aiRead : null,
        finalValue: m.finalValue != null ? m.finalValue : null,
        overridden: !!m.overridden,
        reason: m.reason || "",
        deltaPct: m.deltaPct != null ? m.deltaPct : null,
      })),
      tierDecisions: (decided.tierDecisions || []).map((t) => ({
        tier: t.tier,
        name: t.name,
        aiSuggested: t.aiSuggested != null ? t.aiSuggested : null,
        panelQuote: t.panelQuote != null ? t.panelQuote : null,
        finalPrice: t.finalPrice != null ? t.finalPrice : null,
        overridden: !!t.overridden,
        reason: t.reason || "",
        deltaPct: t.deltaPct != null ? t.deltaPct : null,
      })),
    },
    addedBy: who(draft.addedBy),
    addedAt: draft.addedAt || null,
    // Whether this draft was priced from the panel's own cached read.
    readSource: (draft.sourceRead && draft.sourceRead.source) || null,
  };
};

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
//                           includeExamples?, categoryOverride?, pinId?,
//                           reanalyse? }
//
// READ CACHING (2026-08-17). The vision read is cached per image, so revisiting a
// pin returns the SAME measurement and therefore the same price — the founder's
// requirement, and the fix for a temperature-1.0 model that reads the same photo
// ±25% differently. Lookup order:
//   (a) the pin is already an approved+published product → the LIVE product price
//   (b) a stored read exists                            → replay it
//   (c) miss                                            → one AI call, then store
// `reanalyse: true` forces (c) and overwrites the stored read. It is never
// automatic: a re-read is a staff decision, because it can legitimately change a
// price the client was already quoted. It also skips (a) — a staff member who
// asks the AI to look again must not be handed the store price instead.
// Read-only. Vision (demo mode) → category; non-décor → { rejected }. Otherwise a
// category-aware PRICE LADDER (per size bucket for Stage/Mandap, one category-band
// row otherwise) from the Phase A engine. Raw prices, NO uplift. The size ladder
// exists so the human asks the client the size — the model's size is ignored.
// `categoryOverride` (a valid category name) SKIPS the vision call entirely and
// prices that category directly: the panel's staff dropdown must be instant, and
// a wrong category is a ~2× price error only the human on the call can fix.
const DemoPrice = async (req, res) => {
  const { imageBase64, imageUrl, image, pinText, includeExamples, categoryOverride, stageMeasurements, pinId, reanalyse } = req.body || {};
  const forceRead = reanalyse === true;

  let analysis;
  // Where the answer came from — attached to the response as `read`.
  let read = { origin: "fresh", firstReadAt: null };
  if (categoryOverride != null) {
    // demoCategoryTiers also admits demo-only categories (Haldi) that have no
    // catalog taxonomy entry.
    if (!demoCategoryTiers(categoryOverride)) {
      return res.status(400).send({ message: `Unknown décor category: ${JSON.stringify(categoryOverride)}` });
    }
    // Staff said what it is — no vision, so no confidence and no observations.
    // The panel may resend the earlier vision backdrop measurement so an
    // override TO Stage keeps floral-run pricing (buildDemoPrice validates it).
    //
    // ⛔ THE CACHE IS NOT TOUCHED ON THIS PATH — neither read nor written.
    // Not read: there is no AI spend to save (no vision call happens here) and
    // the "analysis" is two fields the caller already asserted.
    // NOT WRITTEN, and this is the important half: a category override is a
    // STAFF CORRECTION, not a reading of the image. Storing a hand-asserted
    // category under an image key would poison the next genuine read of that
    // pin — the correction would come back as though the model had made it.
    analysis = {
      isDecorProduct: true,
      category: categoryOverride,
      categoryConfidence: null,
      observations: [],
      stageMeasurements: stageMeasurements || null,
    };
    // No image was read, so there is no provenance to report. Claiming "fresh"
    // here would tell the panel the AI had just looked at the photo.
    read = null;
  } else {
    const b64 = imageBase64 || (typeof image === "string" && !/^https?:\/\//i.test(image) ? image : undefined);
    const url = imageUrl || (typeof image === "string" && /^https?:\/\//i.test(image) ? image : undefined);
    if (!b64 && !url) {
      return res.status(400).send({ message: "image (base64) or imageUrl is required" });
    }

    // ── PIN-LEVEL READ CACHE (2026-08-17) ────────────────────────────────────
    // Sits HERE deliberately: after URL resolution (we need the URL to build the
    // key) and BEFORE the API-key guard below, so a known image is answered even
    // with no key configured — and, more to the point, before the image fetch and
    // before the AI call. Everything downstream (pinTextCheck, occasion,
    // comparables) still runs per-request; only the READ is replayed.
    //
    // A base64-only caller has no stable key and skips the cache entirely rather
    // than us inventing a content hash (see decorImageKey).
    const key = readCache.imageKeyFor({ imageUrl: url, pinId });
    if (key.usable && !forceRead) {
      try {
        // (a) The pin is already a product → the human's price wins outright.
        const published = await readCache.publishedForImage({ imageUrl: url, pinId });
        if (published) {
          const prior = await readCache.lookupRead(key);
          const out = buildStorePrice(published.decor, { analysis: prior && prior.analysis });
          // pinTextCheck is computed here rather than at the shared line below
          // because this branch returns early — it never reaches the estimator.
          const storeCheck = pinTextCategoryCheck(pinText, published.decor.category);
          return res.status(200).send(
            shapeClientResponse("demo-price", {
              ...out,
              ...(storeCheck ? { pinTextCheck: storeCheck } : {}),
              read: {
                origin: "from-store",
                firstReadAt: prior ? prior.firstReadAt : null,
                product: {
                  code: (published.decor.productInfo && published.decor.productInfo.id) || "",
                  name: published.decor.name || "",
                },
              },
            })
          );
        }

        // (b) Cache hit → replay the stored read.
        const hit = await readCache.lookupRead(key);
        if (hit) {
          analysis = hit.analysis;
          read = { origin: "cached", firstReadAt: hit.firstReadAt };
          readCache.touchRead(hit._id);
        }
      } catch (e) {
        // A cache failure must never take down a live sales call — fall through
        // and pay for a fresh read.
        console.warn("[DemoPrice] cache lookup failed", e && e.message);
      }
    }

    // (c) Miss (or a deliberate reanalyse) → one AI call, then store it.
    if (!analysis) {
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

      if (key.usable) {
        const stored = await readCache.storeRead(
          { imageUrl: url, pinId, analysis, reanalyse: forceRead },
          req.auth && req.auth.user_id
        );
        read = { origin: "fresh", firstReadAt: (stored && stored.firstReadAt) || null };
      }
    }
  }

  const pinTextCheck = pinTextCategoryCheck(pinText, analysis.category);
  // Occasion (caption + vision) decides which pricing model applies (haldi has
  // its own rate). Deliberately NOT resolved on a category override — the
  // dropdown is the correction path and must never be re-flipped.
  const occasion = categoryOverride != null ? null : resolveOccasion(pinText, analysis.occasion);

  // Non-décor → reject, no pricing, no comparables. The rejection is cached like
  // any other read: re-checking the same non-décor photo must not re-bill it.
  if (!analysis.isDecorProduct) {
    const out = buildDemoPrice(analysis, [], { includeExamples: false });
    return res.status(200).send(
      shapeClientResponse("demo-price", {
        ...out,
        ...(pinTextCheck ? { pinTextCheck } : {}),
        ...(read ? { read } : {}),
      })
    );
  }

  try {
    // Examples + non-sized band prices come from ORDERABLE products only.
    const docs = await Decor.find(
      { category: analysis.category, productVisibility: true, productAvailability: true },
      "name productInfo.id productInfo.measurements productTypes image thumbnail"
    ).lean();
    const comparables = docs.map(normalizeComparable);
    const out = buildDemoPrice(analysis, comparables, { includeExamples: !!includeExamples, occasion });
    return res.status(200).send(
      shapeClientResponse("demo-price", {
        ...out,
        ...(pinTextCheck ? { pinTextCheck } : {}),
        ...(read ? { read } : {}),
      })
    );
  } catch (error) {
    return res.status(400).send({ message: "error", error });
  }
};

// GET /decor/:_id/analysis — the AI analysis behind a published product.
// 404 + code NO_DRAFT is the NORMAL answer for a manually-added product; the
// catalogue branches on the code to decide whether to show the tab.
const DecorAnalysis = async (req, res) => {
  try {
    const draft = await DecorDraftService.analysisForDecor(req.params._id);
    return res.send(shapeDecorAnalysis(draft));
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    if (status >= 500) console.error("[DecorAnalysis]", error && error.message, error);
    return res.status(status).send({
      message: (error && error.message) || "error",
      ...(error && error.code ? { code: error.code } : {}),
    });
  }
};

// ─── AI listing helpers ──────────────────────────────────────────────────────


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

    // Live catalogue context — one shared builder, so A2S and this endpoint can
    // never supply different context to the same prompt.
    const listingContext = await buildListingContext(category);

    // ── ONE BRAIN (2026-08-19) ────────────────────────────────────────────
    // This endpoint used to run its own weak autofill prompt, then briefly a
    // fenced "listing" mode. Both are gone: FULL mode now makes the pricing
    // judgement and writes the catalogue copy in a single call, and A2S runs the
    // same one. The fence that kept them apart protected `style` from moving a
    // price; since 2026-08-19 no pricing path reads style at all, so there is
    // nothing left to fence. See the note above FULL_SCHEMA_INSTR.
    //
    // It also inherits the vision layer's retry: the deleted listing brain had
    // NONE, so a momentary 429/529 silently cost the name, description and tags.
    let analysis;
    try {
      analysis = await analyseImage({ imageBase64: img.data, mode: "full", listingContext });
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
    // it by the same rule as before.
    //
    // seoKeywords, occasions and detectedAesthetic are GONE by ruling: the first
    // was unused, the second is read better by the pricing half, and nothing ever
    // consumed the third. They are returned as empty/null for one release so the
    // form does not break on a missing key.
    return res.send({
      name: analysis.suggestedName || "",
      description: analysis.description || "",
      category,
      style: analysis.style ? [analysis.style] : [],
      colors: analysis.colors || [],
      flowers: analysis.flowers || [],
      fabric: analysis.fabric || [],
      tags: analysis.tags || [],
      included: includedFor(category),
      detectedCategory: analysis.category || null,
      categoryConfidence: analysis.categoryConfidence,
      size: analysis.size || null,
      complexity: analysis.complexity || null,
      // Retired 2026-08-19 — see above. Remove once the form stops reading them.
      seoKeywords: [],
      occasions: [],
      detectedAesthetic: null,
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
  DecorAnalysis,
  // exported for the response-contract test — the wire-shaping boundary
  shapeClientResponse, shapeDemoPrice, shapeAnalyseImage, shapeDecorAnalysis,
};

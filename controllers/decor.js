const Decor = require("../models/Decor");
const Attribute = require("../models/Attribute");
const Anthropic = require("@anthropic-ai/sdk");

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

const CreateNew = (req, res) => {
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
    Decor.find({ spotlight: true })
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
        Decor.find(query)
          .sort(sortQuery)
          .skip(skip)
          .limit(limit)
          .exec()
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
    const { spotlightColor } = req.body;
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          spotlight: true,
          spotlightColor,
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
    Decor.findByIdAndUpdate(
      { _id },
      {
        $set: {
          label: addTo,
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

    const userText = `Category: ${category}

existing_names (avoid similarity):
${JSON.stringify(existingNames)}

attribute_options (use ONLY these values for the matching fields; return [] if unsure):
${JSON.stringify(attributeOptions)}`;

    let message;
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      message = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: AI_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.mediaType,
                  data: img.data,
                },
              },
              { type: "text", text: userText },
            ],
          },
        ],
      });
    } catch (apiErr) {
      return sendAnthropicError(res, apiErr, "AiAnalyze");
    }

    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    try {
      const parsed = JSON.parse(stripJsonFence(text));

      // Hardcode the 'included' list based on category — the AI is no
      // longer asked to think about it.
      const cat = (category || "").toLowerCase();
      const seaterCategories = ["stage", "mandap"];
      const ledCategories = [
        "stage",
        "mandap",
        "photobooth",
        "pathway",
        "nameboard",
        "entrance arch",
      ];
      const included = [
        "Decor as shown in image",
        "Props as shown in image",
      ];
      if (seaterCategories.some((c) => cat.includes(c))) {
        included.unshift("Seaters included");
      }
      if (ledCategories.some((c) => cat.includes(c))) {
        included.unshift("LED PAR Cans included");
      }
      parsed.included = included;

      return res.send(parsed);
    } catch (e) {
      console.error("[AiAnalyze] JSON parse failed. Raw response:\n", text);
      return res.status(502).send({
        message: "AI returned an unexpected response format",
        error: e?.message || String(e),
        raw: text,
      });
    }
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

module.exports = { CreateNew, GetAll, Get, Update, Delete, AiAnalyze, AiRegenerate };

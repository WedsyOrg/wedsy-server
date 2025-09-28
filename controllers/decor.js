const Decor = require("../models/Decor");

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
    Decor.aggregate([
      {
        $match: {
          _id: { $ne: similarDecorFor },
        },
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

module.exports = { CreateNew, GetAll, Get, Update, Delete };

const DecorPackage = require("../models/DecorPackage");

const CreateNew = (req, res) => {
  const { name, variant, included, decor, description, seoTags } = req.body;
  if (!name || decor.length <= 0) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new DecorPackage({
      name,
      variant,
      included,
      decor,
      description,
      seoTags,
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
  const { search, sort } = req.query;
  const query = {};
  const sortQuery = {};
  if (search) {
    query.$or = [
      { name: { $regex: new RegExp(search, "i") } },
      { included: { $regex: new RegExp(search, "i") } },
    ];
  }
  if (sort) {
    if (sort === "Price:Low-to-High") {
      sortQuery["variant.artificialFlowers.sellingPrice"] = 1;
    } else if (sort === "Price:High-to-Low") {
      sortQuery["variant.artificialFlowers.sellingPrice"] = -1;
    }
  }
  DecorPackage.countDocuments(query)
    .then((total) => {
      const totalPages = Math.ceil(total / limit);
      const validPage = page % totalPages;
      const skip =
        validPage === 0 || validPage === null || validPage === undefined
          ? 0
          : (validPage - 1) * limit;
      DecorPackage.find(query)
        .sort(sortQuery)
        .skip(skip)
        .limit(limit)
        .populate("decor")
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
};

const Get = (req, res) => {
  const { _id } = req.params;
  DecorPackage.findById({ _id })
    .populate("decor")
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
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { name, variant, included, decor, description, seoTags } = req.body;
  if (!name || !category) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    DecorPackage.findByIdAndUpdate(
      { _id },
      {
        $set: {
          name,
          variant,
          included,
          decor,
          description,
          seoTags,
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
};

const Delete = (req, res) => {
  const { _id } = req.params;
  DecorPackage.findByIdAndDelete({ _id })
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

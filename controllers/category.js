const Category = require("../models/Category");

const CreateNew = (req, res) => {
  const {
    name,
    order,
    status,
    images,
    attributes,
    addOns,
    productTypes,
    platformAllowed,
    flooringAllowed,
    multipleAllowed,
    adminEventToolView,
    websiteView,
  } = req.body;
  if (!name) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Category({
      name,
      order,
      status,
      images,
      attributes,
      addOns,
      productTypes,
      platformAllowed,
      flooringAllowed,
      multipleAllowed,
      adminEventToolView,
      websiteView,
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
  Category.find({})
    .then((result) => {
      res.send(
        result?.sort((a, b) =>
          a.order === -1 && b.order === -1
            ? 0
            : a.order === -1 && b.order >= 0
            ? 1
            : b.order === -1 && a.order >= 0
            ? -1
            : (a.order || 0) - (b.order || 0)
        )
      );
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
  Category.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send(result);
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Update = (req, res) => {
  const { _id } = req.params;
  const {
    name,
    order,
    status,
    images,
    attributes,
    addOns,
    productTypes,
    platformAllowed,
    flooringAllowed,
    multipleAllowed,
    adminEventToolView,
    websiteView,
  } = req.body;
  if (!name) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Category.findByIdAndUpdate(
      { _id },
      {
        $set: {
          name,
          order,
          status,
          images,
          attributes,
          addOns,
          productTypes,
          platformAllowed,
          flooringAllowed,
          multipleAllowed,
          adminEventToolView,
          websiteView,
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
  Category.findByIdAndDelete({ _id })
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

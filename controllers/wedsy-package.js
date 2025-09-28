const WedsyPackage = require("../models/WedsyPackage");

const CreateNew = (req, res) => {
  const {
    name,
    category,
    people,
    time,
    details,
    image,
    process,
    operations,
    price,
  } = req.body;
  if (!name || !category || !people || !time || !details || !image) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new WedsyPackage({
      name,
      category,
      people,
      time,
      details,
      image,
      process,
      operations,
      price,
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
  WedsyPackage.find({})
    .then((result) => {
      res.send(result);
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
  WedsyPackage.findById({ _id })
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
    category,
    people,
    time,
    details,
    image,
    process,
    operations,
    price,
  } = req.body;
  if (!name || !category || !people || !time || !details || !image) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    WedsyPackage.findByIdAndUpdate(
      { _id },
      {
        $set: {
          name,
          category,
          people,
          time,
          details,
          image,
          process,
          operations,
          price,
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
  WedsyPackage.findByIdAndDelete({ _id })
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

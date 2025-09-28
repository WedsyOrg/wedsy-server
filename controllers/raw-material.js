const RawMaterial = require("../models/RawMaterial");

const CreateNew = (req, res) => {
  const { name, unit, price } = req.body;
  if (!name || !unit || !price) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new RawMaterial({
      name,
      unit,
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
  RawMaterial.find({})
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
  RawMaterial.findById({ _id })
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
  const { name, unit, price } = req.body;
  if (!name || !unit || !price) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    RawMaterial.findByIdAndUpdate(
      { _id },
      {
        $set: {
          name,
          unit,
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
  RawMaterial.findByIdAndDelete({ _id })
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

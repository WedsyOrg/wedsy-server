const Discount = require("../models/Discount");

const CreateNew = (req, res) => {
  const {
    title,
    discountPercentage,
    discountAmount,
    decorItems,
    categories,
    status,
  } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Discount({
      title,
      discountPercentage,
      discountAmount,
      decorItems,
      categories,
      status,
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
  Discount.find({})
    .populate("decorItems", "name productInfo.id")
    .exec()
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
  Discount.findById({ _id })
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
    title,
    discountPercentage,
    discountAmount,
    decorItems,
    categories,
    status,
  } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Discount.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
          discountPercentage,
          discountAmount,
          decorItems,
          categories,
          status,
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

const UpdateStatus = (req, res) => {
  const { _id } = req.params;
  const { status } = req.body;
  if (status === undefined || status === null) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Discount.findByIdAndUpdate(
      { _id },
      {
        $set: {
          status,
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
  Discount.findByIdAndDelete({ _id })
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

module.exports = { CreateNew, GetAll, Get, Update, UpdateStatus, Delete };

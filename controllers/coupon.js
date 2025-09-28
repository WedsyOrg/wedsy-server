const Coupon = require("../models/Coupon");

const CreateNew = (req, res) => {
  const {
    title,
    couponPercentage,
    couponAmount,
    decorItems,
    categories,
    status,
  } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Coupon({
      title,
      couponPercentage,
      couponAmount,
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
  Coupon.find({})
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
  Coupon.findById({ _id })
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
    couponPercentage,
    couponAmount,
    decorItems,
    categories,
    status,
  } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Coupon.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
          couponPercentage,
          couponAmount,
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
    Coupon.findByIdAndUpdate(
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
  Coupon.findByIdAndDelete({ _id })
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

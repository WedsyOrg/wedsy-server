const Taxation = require("../models/Taxation");

const CreateNew = (req, res) => {
  const { title, sgst, cgst, decorItems, categories, status } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Taxation({
      title,
      sgst,
      cgst,
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
  Taxation.find({})
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
  Taxation.findById({ _id })
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
  const { title, sgst, cgst, decorItems, categories, status } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Taxation.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
          sgst,
          cgst,
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
    Taxation.findByIdAndUpdate(
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
  Taxation.findByIdAndDelete({ _id })
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

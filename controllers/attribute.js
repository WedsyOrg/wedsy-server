const Attribute = require("../models/Attribute");

const CreateNew = (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Attribute({
      name,
      list: [],
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
  Attribute.find({})
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
  Attribute.findById({ _id })
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
  const { name } = req.body;
  if (!name) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Attribute.findByIdAndUpdate(
      { _id },
      {
        $set: {
          name,
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

const AddtoList = (req, res) => {
  const { _id } = req.params;
  const { item } = req.body;
  if (!item) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Attribute.findByIdAndUpdate(
      { _id },
      {
        $addToSet: {
          list: item,
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

const RemoveFromList = (req, res) => {
  const { _id } = req.params;
  const { item } = req.body;
  if (!item) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Attribute.findByIdAndUpdate(
      { _id },
      {
        $pull: {
          list: item,
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
  Attribute.findByIdAndDelete({ _id })
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

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Update,
  Delete,
  AddtoList,
  RemoveFromList,
};

const VendorMakeupStyle = require("../models/VendorMakeupStyle");

const CreateNew = (req, res) => {
  const { title } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new VendorMakeupStyle({
      title,
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
  VendorMakeupStyle.find({})
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
  VendorMakeupStyle.findById({ _id })
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
  const { title } = req.body;
  if (!title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorMakeupStyle.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
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

const AddPreferredLook = (req, res) => {
  const { _id } = req.params;
  const { preferredLook } = req.body;
  if (!preferredLook) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorMakeupStyle.findByIdAndUpdate(
      { _id },
      {
        $addToSet: {
          preferredLook,
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

const RemovePreferredLook = (req, res) => {
  const { _id } = req.params;
  const { preferredLook } = req.body;
  if (!preferredLook) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorMakeupStyle.findByIdAndUpdate(
      { _id },
      {
        $pull: {
          preferredLook,
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
  VendorMakeupStyle.findByIdAndDelete({ _id })
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
  AddPreferredLook,
  RemovePreferredLook,
};

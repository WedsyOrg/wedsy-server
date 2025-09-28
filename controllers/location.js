const Location = require("../models/Location");

const CreateNew = (req, res) => {
  const { title, locationType, parent } = req.body;
  if (!title || !locationType || (locationType !== "State" && !parent)) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Location({
      title,
      locationType,
      parent: parent || null,
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
  const { locationType, parent } = req.query;
  let query = {};
  if (locationType) {
    query.locationType = locationType;
  }
  if (parent) {
    query.parent = parent;
  }
  Location.find(query)
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
  Location.findById({ _id })
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
  const { title, locationType, parent } = req.body;
  if (!title || !locationType || (locationType !== "State" && !parent)) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Location.findByIdAndUpdate(
      { _id },
      {
        $set: {
          title,
          locationType,
          parent: parent || null,
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
  const deleteLocation = (locationId) => {
    return new Promise((resolve, reject) => {
      Location.findByIdAndDelete({ _id: locationId })
        .then((result) => {
          if (result) {
            Location.find({ parent: locationId })
              .then((list) => {
                if (list.length > 0) {
                  Promise.all(
                    list.map((item) => deleteLocation(item._id))
                  ).then((r) => {
                    resolve(result);
                  });
                } else {
                  resolve(result);
                }
              })
              .catch((error) => {
                reject(error);
              });
          } else {
            resolve(result);
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  };
  deleteLocation(_id)
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

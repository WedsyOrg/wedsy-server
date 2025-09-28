const Config = require("../models/Config");

const Get = (req, res) => {
  const { code } = req.query;
  if (code) {
    Config.findOne({ code })
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
  } else {
    res.status(404).send();
  }
};

const Update = (req, res) => {
  const { code, data } = req.body;
  if (!code) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Config.findOneAndUpdate(
      { code },
      {
        $set: {
          data,
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

module.exports = { Get, Update };

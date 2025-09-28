const Quotation = require("../models/Quotation");

const CreateNew = (req, res) => {
  const { user_id } = req.auth;
  const { location, comment, image, source } = req.body;
  if (!location || !comment || !source || !image) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Quotation({ user: user_id, location, comment, image, source })
      .save()
      .then((result) => {
        res.status(201).send();
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

module.exports = {
  CreateNew,
};

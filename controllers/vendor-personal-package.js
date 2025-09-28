const VendorPersonalPackage = require("../models/VendorPersonalPackage");

const CreateNew = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { name, services, price, amountToVendor, amountToWedsy, vendorId } =
    req.body;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else if (!name || !price || services.length === 0) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new VendorPersonalPackage({
      vendor: isVendor ? user_id : vendorId,
      name,
      services,
      price,
      amountToVendor,
      amountToWedsy,
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
  const { user_id, isVendor, isAdmin } = req.auth;
  const { vendorId } = req.query;
  const query = {};
  if (isVendor) {
    query.vendor = user_id;
  } else if (!isAdmin) {
    query.active = { $ne: false };
  }
  if (vendorId) {
    query.vendor = vendorId;
  }
  VendorPersonalPackage.find(query)
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
  const { user_id, isVendor } = req.auth;
  const { _id } = req.params;
  VendorPersonalPackage.findOne(isVendor ? { _id, vendor: user_id } : { _id })
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
  const { user_id, isAdmin, isVendor } = req.auth;
  const { name, services, price, amountToVendor, amountToWedsy } = req.body;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else if (!name || !price || services.length === 0) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorPersonalPackage.findOneAndUpdate(
      isVendor ? { _id, vendor: user_id } : { _id },
      { $set: { name, services, price, amountToVendor, amountToWedsy } }
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
  const { user_id, isAdmin, isVendor } = req.auth;
  const { active } = req.body;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else if (active === undefined || active === null) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorPersonalPackage.findOneAndUpdate(
      isVendor ? { _id, vendor: user_id } : { _id },
      { $set: { active } }
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
  const { user_id, isAdmin, isVendor } = req.auth;
  const { _id } = req.params;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
    return;
  }
  VendorPersonalPackage.findOneAndDelete(
    isVendor ? { _id, vendor: user_id } : { _id }
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
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Update,
  UpdateStatus,
  Delete,
};

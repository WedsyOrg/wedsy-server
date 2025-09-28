const VendorPersonalLead = require("../models/VendorPersonalLead");
const Enquiry = require("../models/Enquiry");

const CreateNew = (req, res) => {
  const { user_id } = req.auth;
  const { name, phone, notes, eventInfo, tasks, payment } = req.body;
  if (!name || !phone) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new VendorPersonalLead({
      vendor: user_id,
      name,
      phone,
      notes,
      eventInfo,
      tasks,
      payment,
    })
      .save()
      .then((result) => {
        new Enquiry({
          name,
          phone,
          email: "",
          verified: false,
          source: "Vendor Personal Leads",
          additionalInfo: { vendor: user_id },
        })
          .save()
          .then((r) => {
            res.status(201).send({ message: "success", id: result._id });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId } = req.query;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else {
    VendorPersonalLead.find(
      isAdmin ? (vendorId ? { vendor: vendorId } : {}) : { vendor: user_id }
    )
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  }
};

const Get = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { _id } = req.params;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else {
    VendorPersonalLead.findOne(isAdmin ? { _id } : { _id, vendor: user_id })
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
  }
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { user_id } = req.auth;
  const { name, phone, notes, eventInfo, tasks, payment } = req.body;
  if (
    !name &&
    !phone &&
    !notes &&
    ![eventInfo, tasks, payment].filter((i) => i !== null && i !== undefined)
      ?.length > 0
  ) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    const updates = {};
    if (name) {
      updates.name = name;
    }
    if (phone) {
      updates.phone = phone;
    }
    if (notes) {
      updates.notes = notes;
    }
    if (payment !== null || payment !== undefined) {
      updates.payment = payment;
    }
    if (tasks !== null || tasks !== undefined) {
      updates.tasks = tasks;
    }
    if (eventInfo !== null || eventInfo !== undefined) {
      updates.eventInfo = eventInfo;
    }

    VendorPersonalLead.findByIdAndUpdate(
      { _id, vendor: user_id },
      { $set: updates }
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

const UpdateAdminNotes = (req, res) => {
  const { _id } = req.params;
  const { admin_notes } = req.body;
  if (!admin_notes) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorPersonalLead.findByIdAndUpdate({ _id }, { $set: { admin_notes } })
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
  const { user_id } = req.auth;
  const { _id } = req.params;
  VendorPersonalLead.findOneAndDelete({ _id, vendor: user_id })
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
  UpdateAdminNotes,
};

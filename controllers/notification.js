const mongoose = require("mongoose");
const Notification = require("../models/Notification");

const CreateNew = (req, res) => {
  const { category, title, references } = req.body;
  if (!category || !title) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Notification({
      category,
      title,
      references,
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
  const { category, date, startDate, endDate } = req.query;
  const query = {};
  
  console.log("Notification GetAll - user_id:", user_id, "isVendor:", isVendor, "isAdmin:", isAdmin);
  
  // Vendor-specific notifications
  if (isVendor) {
    query.vendor = user_id;
    console.log("Filtering for vendor:", user_id);
  } else if (!isAdmin) {
    query.user = user_id;
    console.log("Filtering for user:", user_id);
  }
  
  if (category) {
    query.category = category;
  }
  if (date) {
    const filterDate = new Date(date);
    const startFilterDate = new Date(filterDate.setHours(0, 0, 0, 0));
    const endFilterDate = new Date(filterDate.setHours(23, 59, 59, 999));
    query["createdAt"] = {
      $gte: startFilterDate,
      $lt: endFilterDate,
    };
  }
  if (startDate && endDate) {
    const startFilterDate = new Date(new Date(startDate).setHours(0, 0, 0, 0));
    const endFilterDate = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    query["createdAt"] = {
      $gte: startFilterDate,
      $lt: endFilterDate,
    };
  }
  
  console.log("Query for notifications:", JSON.stringify(query, null, 2));
  
  Notification.find(query)
    .sort({ createdAt: -1 })
    .lean()
    .then((result) => {
      console.log("Found notifications:", result.length);
      res.send({ list: result });
    })
    .catch((error) => {
      console.error("Error fetching notifications:", error);
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const GetUnreadCount = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const query = { read: false };
  
  if (isVendor) {
    query.vendor = user_id;
  } else if (!isAdmin) {
    query.user = user_id;
  }
  
  Notification.countDocuments(query)
    .then((count) => {
      res.send({ count });
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const MarkAsRead = (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const query = { _id };
  
  if (isVendor) {
    query.vendor = user_id;
  } else if (!isAdmin) {
    query.user = user_id;
  }
  
  Notification.findOneAndUpdate(query, { $set: { read: true } })
    .then((result) => {
      if (result) {
        res.send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const DeleteById = (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const query = { _id };
  
  if (isVendor) {
    query.vendor = user_id;
  } else if (!isAdmin) {
    query.user = user_id;
  }
  
  Notification.findOneAndDelete(query)
    .then((result) => {
      if (result) {
        res.send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const DeleteAll = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const query = {};
  
  if (isVendor) {
    query.vendor = user_id;
  } else if (!isAdmin) {
    query.user = user_id;
  }
  
  Notification.deleteMany(query)
    .then((result) => {
      res.send({ 
        message: "success", 
        deletedCount: result.deletedCount 
      });
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

module.exports = { CreateNew, GetAll, GetUnreadCount, MarkAsRead, DeleteById, DeleteAll };

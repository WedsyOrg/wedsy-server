const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const { VerifyOTP } = require("../utils/otp");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../config/jwt");
const Event = require("../models/Event");
const Payment = require("../models/Payment");
const { SendUpdate } = require("../utils/update");
const { GetPaymentTransactions } = require("../utils/payment");

const CreateNew = (req, res) => {
  const { name, phone, verified, source, Otp, ReferenceId, additionalInfo } =
    req.body;
  if (!name || !phone || !source || verified === undefined) {
    res.status(400).send({ message: "Incomplete Data" });
  } else if (verified && Otp && ReferenceId) {
    VerifyOTP(phone, ReferenceId, Otp)
      .then((result) => {
        if (result.Valid === true) {
          User.findOne({ phone })
            .then((user) => {
              if (user) {
                const { _id } = user;
                const token = jwt.sign(
                  { _id },
                  process.env.JWT_SECRET,
                  jwtConfig
                );
                new Enquiry({
                  name,
                  phone,
                  verified,
                  source,
                  additionalInfo: additionalInfo || {},
                })
                  .save()
                  .then((result) => {
                    SendUpdate({
                      channels: ["SMS", "Whatsapp"],
                      message: "New Lead",
                      parameters: { name, phone },
                    });
                    res.send({
                      message: "Enquiry Added Successfully",
                      token,
                    });
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              } else {
                new User({
                  name,
                  phone,
                })
                  .save()
                  .then((result) => {
                    const { _id } = result;
                    const token = jwt.sign(
                      { _id },
                      process.env.JWT_SECRET,
                      jwtConfig
                    );
                    new Enquiry({
                      name,
                      phone,
                      verified,
                      source,
                      additionalInfo: additionalInfo || {},
                    })
                      .save()
                      .then((result) => {
                        SendUpdate({
                          channels: ["SMS", "Whatsapp"],
                          message: "New Lead",
                          parameters: { name, phone },
                        });
                        res.send({
                          message: "Enquiry Added Successfully",
                          token,
                        });
                      })
                      .catch((error) => {
                        res.status(400).send({ message: "error", error });
                      });
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              }
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          res.status(400).send({ message: "Invalid OTP" });
        }
      })
      .catch((err) => {
        res.status(400).send({ message: "error", error: err });
      });
  } else {
    new Enquiry({
      name,
      phone,
      verified: false,
      source,
      additionalInfo: additionalInfo || {},
    })
      .save()
      .then((result) => {
        SendUpdate({
          channels: ["SMS", "Whatsapp"],
          message: "New Lead",
          parameters: { name, phone },
        });
        res.status(201).send();
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = async (req, res) => {
  if (req.query.stats === "true") {
    let stats = {
      total: 0,
      lost: 0,
      interested: 0,
      fresh: 0,
      new: 0,
    };
    let tempDate = new Date();
    tempDate.setHours(0, 0, 0, 0);
    let newDate = tempDate;
    newDate.setDate(newDate.getDate() - 7);
    let freshDate = tempDate;
    freshDate.setDate(freshDate.getDate() - 1);

    stats.total = await Enquiry.countDocuments({});
    stats.lost = await Enquiry.countDocuments({ isLost: true });
    stats.interested = await Enquiry.countDocuments({ isInterested: true });
    stats.new = await Enquiry.countDocuments({
      createdAt: {
        $gte: tempDate,
      },
    });
    stats.fresh = await Enquiry.countDocuments({
      createdAt: {
        $gte: tempDate,
      },
    });
    res.send({ stats });
  } else {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const { source, date, search, sort, status } = req.query;
    const query = {};
    const sortQuery = {};
    if (source) {
      query.source = source;
    }
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.createdAt = {
        $gte: startDate,
        $lt: endDate,
      };
    }
    if (search) {
      query.$or = [
        { name: { $regex: new RegExp(search, "i") } },
        { email: { $regex: new RegExp(search, "i") } },
        { phone: { $regex: new RegExp(search, "i") } },
      ];
    }
    if (sort) {
      if (sort === "Date: Oldest") {
        sortQuery.createdAt = 1;
      } else if (sort === "Date: Newest") {
        sortQuery.createdAt = -1;
      }
    } else {
      sortQuery.createdAt = -1;
    }
    if (status) {
      // Fresh, New, Hot, Potential, Cold, Lost, Interested, Verified, Not Verified
      if (status === "Interested") {
        query.isInterested = true;
      } else if (status === "Lost") {
        query.isLost = true;
      } else if (status === "Verified") {
        query.verified = true;
      } else if (status === "NotVerified") {
        query.verified = false;
      } else if (status === "Fresh" || status === "New") {
        let tempDate = new Date();
        tempDate.setHours(0, 0, 0, 0);
        if (status === "Fresh") {
          tempDate.setDate(tempDate.getDate() - 1);
        } else if (status === "New") {
          tempDate.setDate(tempDate.getDate() - 7);
        }
        query.createdAt = {
          $gte: tempDate,
        };
      }
    }
    if (!(status && ["Hot", "Potential", "Cold"].includes(status))) {
      Enquiry.countDocuments(query)
        .then((total) => {
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;
          // const pipeline = [
          //   {
          //     $lookup: {
          //       from: "users",
          //       localField: "phone",
          //       foreignField: "phone",
          //       as: "user",
          //     },
          //   },
          //   {
          //     $unwind: {
          //       path: "$user",
          //       preserveNullAndEmptyArrays: true, // Include documents without matching users
          //     },
          //   },
          //   {
          //     $lookup: {
          //       from: "events",
          //       localField: "user._id",
          //       foreignField: "user",
          //       as: "events",
          //     },
          //   },
          //   {
          //     $unwind: {
          //       path: "$events",
          //       preserveNullAndEmptyArrays: true, // Include documents without matching events
          //     },
          //   },
          //   { $sort: sortQuery },
          //   {
          //     $group: {
          //       _id: "$_id", // Group by the Enquiry document ID
          //       user: { $first: "$user" }, // Take the first user (assuming there's at most one)
          //       event: { $first: "$events" }, // Take the first event for the user
          //       enquiryFields: { $first: "$$ROOT" },
          //     },
          //   },
          //   {
          //     $project: {
          //       _id: "$enquiryFields._id",
          //       name: "$enquiryFields.name",
          //       phone: "$enquiryFields.phone",
          //       email: "$enquiryFields.email",
          //       verified: "$enquiryFields.verified",
          //       isInterested: "$enquiryFields.isInterested",
          //       isLost: "$enquiryFields.isLost",
          //       source: "$enquiryFields.source",
          //       updates: "$enquiryFields.updates",
          //       user: "$user",
          //       event: "$event",
          //       createdAt: "$enquiryFields.createdAt",
          //       updatedAt: "$enquiryFields.updatedAt",
          //     },
          //   },
          //   {
          //     $match: {
          //       $or: [
          //         { "user._id": { $exists: false } }, // Include entries without users
          //         { "events._id": { $exists: false } }, // Include entries without events
          //         { ...query }, // Include entries that match the query
          //       ],
          //     },
          //   },
          //   {
          //     $facet: {
          //       metadata: [{ $count: "total" }],
          //       result: [{ $skip: skip }, { $limit: limit }],
          //     },
          //   },
          // ];
          Enquiry
            // .aggregate([
            //   ...pipeline,
            //   // { $skip: skip },
            //   // { $limit: limit },
            //   // { $sort: sortQuery },
            // ])
            .find(query)
            .sort(sortQuery)
            .skip(skip)
            .limit(limit)
            .exec()
            .then((result) => {
              // res.send({ list: result[0].result, totalPages, page, limit });
              res.send({ list: result, totalPages, page, limit });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    } else {
      // Hot, Potential, Cold
      const tempCurrentDate = new Date();
      const tempStartDate = new Date(tempCurrentDate);
      const tempEndDate = new Date(tempCurrentDate);
      if (status === "Hot") {
        tempStartDate.setDate(tempCurrentDate.getDate() + 0 * 7); // 0 weeks
        tempEndDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
      } else if (status === "Potential") {
        tempStartDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
        tempEndDate.setDate(tempCurrentDate.getDate() + 20 * 7); // 20 weeks
      } else if (status === "Cold") {
        // tempStartDate.setDate(tempCurrentDate.getDate() + 8 * 7); // 8 weeks
        tempStartDate.setDate(tempCurrentDate.getDate() + 20 * 7); // 20 weeks
      }
      tempStartDate.setHours(0, 0, 0, 0);
      tempEndDate.setHours(23, 59, 59, 999);

      const pipeline = [
        {
          $lookup: {
            from: "users",
            localField: "phone",
            foreignField: "phone",
            as: "user",
          },
        },
        {
          $unwind: "$user",
        },
        {
          $lookup: {
            from: "events",
            localField: "user._id",
            foreignField: "user",
            as: "events",
          },
        },
        {
          $unwind: "$events",
        },
        {
          $match: {
            ...query,
            $and:
              status === "Cold"
                ? [
                    {
                      "events.eventDays.date": {
                        $gte: tempStartDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                    // {
                    //   "events.eventDays.date": {
                    //     $lt: tempEndDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                    //   },
                    // },
                  ]
                : [
                    {
                      "events.eventDays.date": {
                        $gte: tempStartDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                    {
                      "events.eventDays.date": {
                        $lt: tempEndDate.toISOString().slice(0, 10), // Convert to ISO string and get only the date part
                      },
                    },
                  ],
          },
        },
      ];

      Enquiry.aggregate(pipeline)
        .then((result) => {
          const total = result.length; // Count the matched documents
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;

          // Apply pagination and sorting to the results
          Enquiry.aggregate([
            ...pipeline,
            { $skip: skip },
            { $limit: limit },
            { $sort: sortQuery },
          ])
            .then((result) => {
              res.send({ list: result, totalPages, page, limit });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    }
  }
};

const Update = (req, res) => {
  const { leadIds, action } = req.body;
  if (action === "MarkInterested") {
    Enquiry.updateMany(
      { _id: { $in: leadIds } },
      { isInterested: true, isLost: false }
    )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send({ message: "success" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (action === "MarkLost") {
    Enquiry.updateMany(
      { _id: { $in: leadIds } },
      { isInterested: false, isLost: true }
    )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send({ message: "success" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdateLead = (req, res) => {
  const { _id } = req.params;
  const { name } = req.body;
  if (name) {
    Enquiry.findByIdAndUpdate({ _id }, { $set: { name } })
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send({ message: "success" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const Delete = (req, res) => {
  const { leadIds } = req.body;
  Enquiry.deleteMany({ _id: { $in: leadIds } })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const Get = (req, res) => {
  const { _id } = req.params;
  Enquiry.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        User.findOne({ phone: result.phone })
          .then((user) => {
            if (!user) {
              res.send({ ...result.toObject(), userCreated: false });
            } else {
              Event.find({ user: user._id })
                .then((events) => {
                  Payment.find({ user: user._id })
                    .populate("event")
                    .then((payments) => {
                      const { totalAmount, amountPaid, amountDue } =
                        events.reduce(
                          (accumulator, e) => {
                            accumulator.totalAmount += e?.amount.total;
                            accumulator.amountPaid += e?.amount.paid;
                            accumulator.amountDue += e?.amount.due;
                            return accumulator;
                          },
                          { totalAmount: 0, amountPaid: 0, amountDue: 0 }
                        );
                      Promise.all(
                        payments.map(async (item) => {
                          let transactions = item.transactions || [];
                          if (
                            item?.razporPayId &&
                            !["cash", "upi", "bank-transfer"].includes(
                              item?.paymentMethod
                            ) &&
                            transactions.length == 0
                          ) {
                            transactions = await GetPaymentTransactions({
                              order_id: item?.razporPayId,
                            });
                          }
                          return { ...item.toObject(), transactions };
                        })
                      )
                        .then((updatedPayments) => {
                          res.send({
                            ...result.toObject(),
                            userCreated: true,
                            user,
                            events,
                            payments: updatedPayments,
                            paymentStats: {
                              totalAmount,
                              amountPaid,
                              amountDue,
                            },
                          });
                        })
                        .catch((error) => {
                          res.status(400).send({ message: "error", error });
                        });
                    })
                    .catch((error) => {
                      res.status(400).send({ message: "error", error });
                    });
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const CreateUser = (req, res) => {
  const { _id } = req.params;
  Enquiry.findById({ _id })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        new User({
          name: result.name,
          phone: result.phone,
        })
          .save()
          .then((user) => {
            res.send({ message: "success" });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const AddConversation = (req, res) => {
  const { _id } = req.params;
  const { conversation } = req.body;
  Enquiry.findByIdAndUpdate(
    { _id },
    { $addToSet: { "updates.conversations": conversation } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateNotes = (req, res) => {
  const { _id } = req.params;
  const { notes } = req.body;
  Enquiry.findByIdAndUpdate({ _id }, { $set: { "updates.notes": notes } })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateCallSchedule = (req, res) => {
  const { _id } = req.params;
  const { callSchedule } = req.body;
  Enquiry.findByIdAndUpdate(
    { _id },
    { $set: { "updates.callSchedule": callSchedule } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
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
  UpdateLead,
  Delete,
  CreateUser,
  AddConversation,
  UpdateNotes,
  UpdateCallSchedule,
};

const Event = require("../models/Event");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const { createInvoice } = require("../utils/invoice");
const {
  CreatePayment,
  GetPaymentStatus,
  GetPaymentTransactions,
} = require("../utils/payment");

const CreateNewPayment = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { event, paymentFor, paymentMethod, amount, user, order } = req.body;
  if (paymentFor === "event" && event && paymentMethod === "razporpay") {
    new Payment({
      user: user_id,
      event: event,
      paymentFor,
      paymentMethod,
      amount: amount * 100,
      amountPaid: 0,
      amountDue: amount * 100,
    })
      .save()
      .then((result) => {
        CreatePayment({ _id: result._id })
          .then((order) => {
            res.status(200).send({
              message: "success",
              _id: result._id,
              order_id: order.id,
              amount: amount * 100,
            });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (
    paymentFor === "makeup-and-beauty" &&
    order &&
    paymentMethod === "razporpay"
  ) {
    new Payment({
      user: user_id,
      order: order,
      paymentFor,
      paymentMethod,
      amount: amount * 100,
      amountPaid: 0,
      amountDue: amount * 100,
    })
      .save()
      .then((result) => {
        CreatePayment({ _id: result._id })
          .then((order) => {
            res.status(200).send({
              message: "success",
              _id: result._id,
              order_id: order.id,
              amount: amount * 100,
            });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (
    paymentFor === "event" &&
    event &&
    user &&
    isAdmin &&
    ["cash", "upi", "bank-transfer"].includes(paymentMethod)
  ) {
    new Payment({
      user: user,
      event: event,
      paymentFor,
      paymentMethod,
      amount: amount * 100,
      amountPaid: amount * 100,
      amountDue: 0,
      status: "paid",
    })
      .save()
      .then(async (result) => {
        const tempEvent = await Event.findOne({
          user: user,
          _id: event,
        });
        const payments = await Payment.find({
          user: user,
          event: event,
          status: "paid",
        });
        let eventTotal = tempEvent.amount.total;
        let paymentTotal = payments.reduce((accumulator, currentValue) => {
          return accumulator + currentValue.amountPaid / 100;
        }, 0);
        if (paymentTotal < eventTotal) {
          Event.findOneAndUpdate(
            {
              _id: event,
              user: user,
            },
            {
              $set: {
                "amount.due": eventTotal - paymentTotal,
                "amount.paid": paymentTotal,
              },
            }
          )
            .then((r) => {
              res.status(200).send({
                message: "success",
                _id: result._id,
              });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else if (paymentTotal == eventTotal) {
          Event.findOneAndUpdate(
            {
              _id: event,
              user: user,
            },
            {
              $set: {
                "amount.due": eventTotal - paymentTotal,
                "amount.paid": paymentTotal,
                "status.paymentDone": true,
                "eventDays.$[elem].status.paymentDone": true,
              },
            },
            {
              arrayFilters: [
                {
                  "elem._id": { $in: event.eventDays.map((i) => i._id) },
                },
              ],
            }
          )
            .then((r) => {
              res.status(200).send({
                message: "success",
                _id: result._id,
              });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          console.log(
            `Error with Payments, event:${event}. Payment: ${paymentTotal}, Event: ${eventTotal}`
          );
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdatePayment = (req, res) => {
  const { user_id } = req.auth;
  const { order_id } = req.params;
  const { response } = req.body;
  GetPaymentStatus({ order_id, response })
    .then((order) => {
      if (order.status === "paid") {
        Payment.findOne({ user: user_id, razporPayId: order_id })
          .then(async (payment) => {
            try {
              if (
                payment?.paymentFor === "event" ||
                payment?.paymentFor === "default"
              ) {
                const event = await Event.findOne({
                  user: user_id,
                  _id: payment.event,
                });
                const payments = await Payment.find({
                  user: user_id,
                  event: payment.event,
                  status: "paid",
                });
                let eventTotal = event.amount.total;
                let paymentTotal = payments.reduce(
                  (accumulator, currentValue) => {
                    return accumulator + currentValue.amountPaid / 100;
                  },
                  0
                );
                if (paymentTotal < eventTotal) {
                  Event.findOneAndUpdate(
                    {
                      _id: event._id,
                      user: user_id,
                    },
                    {
                      $set: {
                        "amount.due": eventTotal - paymentTotal,
                        "amount.paid": paymentTotal,
                      },
                    }
                  )
                    .then((result) => {
                      res.status(200).send({ message: "success" });
                    })
                    .catch((error) => {
                      res.status(400).send({ message: "error", error });
                    });
                } else if (paymentTotal == eventTotal) {
                  Event.findOneAndUpdate(
                    {
                      _id: event._id,
                      user: user_id,
                    },
                    {
                      $set: {
                        "amount.due": eventTotal - paymentTotal,
                        "amount.paid": paymentTotal,
                        "status.paymentDone": true,
                        "eventDays.$[elem].status.paymentDone": true,
                      },
                    },
                    {
                      arrayFilters: [
                        {
                          "elem._id": {
                            $in: event.eventDays.map((i) => i._id),
                          },
                        },
                      ],
                    }
                  )
                    .then((result) => {
                      res.status(200).send({ message: "success" });
                    })
                    .catch((error) => {
                      res.status(400).send({ message: "error", error });
                    });
                } else {
                  console.log(
                    `Error with Payments, event:${event._id}. Payment: ${paymentTotal}, Event: ${eventTotal}`
                  );
                }
              } else if (payment?.paymentFor === "makeup-and-beauty") {
                const order = await Order.findOne({
                  user: user_id,
                  _id: payment.order,
                });
                const payments = await Payment.find({
                  user: user_id,
                  order: payment.order,
                  status: "paid",
                });
                let orderTotal = order.amount.total;
                let paymentTotal = payments.reduce(
                  (accumulator, currentValue) => {
                    return accumulator + currentValue.amountPaid / 100;
                  },
                  0
                );
                if (paymentTotal < orderTotal) {
                  Order.findOneAndUpdate(
                    {
                      _id: order._id,
                      user: user_id,
                    },
                    {
                      $set: {
                        "amount.due": orderTotal - paymentTotal,
                        "amount.paid": paymentTotal,
                      },
                    }
                  )
                    .then((result) => {
                      res.status(200).send({ message: "success" });
                    })
                    .catch((error) => {
                      res.status(400).send({ message: "error", error });
                    });
                } else if (paymentTotal == orderTotal) {
                  Order.findOneAndUpdate(
                    {
                      _id: order._id,
                      user: user_id,
                    },
                    {
                      $set: {
                        "amount.due": orderTotal - paymentTotal,
                        "amount.paid": paymentTotal,
                        "status.paymentDone": true,
                      },
                    }
                  )
                    .then((result) => {
                      res.status(200).send({ message: "success" });
                    })
                    .catch((error) => {
                      res.status(400).send({ message: "error", error });
                    });
                } else {
                  console.log(
                    `Error with Payments, order:${order._id}. Payment: ${paymentTotal}, Order: ${orderTotal}`
                  );
                }
              }
            } catch (error) {
              console.log(error);
              res.status(400).send({ message: "error", error });
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else {
        res.status(200).send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const GetAllPayments = async (req, res) => {
  const { user_id, isAdmin } = req.auth;
  if (isAdmin) {
    // Admin Controller
    const { status, sort, paymentFor } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const query = {};
    const sortQuery = {};
    if (status) {
      query.status = status;
    }
    if (sort) {
      if (sort === "Amount:Low-to-High") {
        sortQuery["amount"] = 1;
      } else if (sort === "Amount:High-to-Low") {
        sortQuery["amount"] = -1;
      }
    }
    if (paymentFor) {
      query.paymentFor = paymentFor;
    }
    Payment.countDocuments(query)
      .then(async (total) => {
        const totalPages = Math.ceil(total / limit);
        const validPage = page !== totalPages ? page % totalPages : totalPages;
        const skip =
          validPage === 0 || validPage === null || validPage === undefined
            ? 0
            : (validPage - 1) * limit;
        const allPayments = await Payment.find({});
        const { totalAmount, amountPaid, amountDue } = allPayments.reduce(
          (accumulator, payment) => {
            accumulator.totalAmount += payment.amount;
            accumulator.amountPaid += payment.amountPaid;
            accumulator.amountDue += payment.amountDue;
            return accumulator;
          },
          { totalAmount: 0, amountPaid: 0, amountDue: 0 }
        );
        Payment.find(query)
          .sort(sortQuery)
          .skip(skip)
          .limit(limit)
          .populate("user event order")
          .exec()
          .then((result) => {
            res.send({
              list: result,
              totalPages,
              page,
              limit,
              totalAmount,
              amountPaid,
              amountDue,
            });
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
    // User Controller
    let payments = await Payment.find({ user: user_id })
      .populate("event")
      .exec();
    let events = await Event.find({ user: user_id });
    let { totalAmount, amountPaid, amountDue } = events
      ?.filter((e) => e?.status?.approved)
      .reduce(
        (accumulator, e) => {
          accumulator.totalAmount += e?.amount?.total;
          accumulator.amountPaid += e?.amount?.paid;
          accumulator.amountDue += e?.amount?.due;
          return accumulator;
        },
        { totalAmount: 0, amountPaid: 0, amountDue: 0 }
      );
    let received = payments
      .filter((p) => p?.status === "paid")
      .reduce((accumulator, e) => {
        return accumulator + e.amountPaid;
      }, 0);
    Promise.all(
      payments.map(async (item) => {
        let transactions = item.transactions || [];
        if (
          item?.razporPayId &&
          !["cash", "upi", "bank-transfer"].includes(item?.paymentMethod) &&
          transactions.length == 0
        ) {
          transactions = await GetPaymentTransactions({
            order_id: item?.razporPayId,
          });
        }
        return { ...item.toObject(), transactions };
      })
    )
      .then((result) => {
        res.send({
          totalAmount,
          amountPaid,
          amountDue,
          payments: result,
          events,
        });
      })
      .catch((error) => res.status(400).send({ message: "error", error }));
  }
};

const GetAllTransactions = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { order_id } = req.params;
  if (isAdmin) {
    GetPaymentTransactions({ order_id })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.send(401);
  }
};

const GetInvoice = (req, res) => {
  const { _id } = req.params;
  if (_id) {
    Payment.findOne({ _id })
      .populate("user event")
      .exec()
      .then(async (result) => {
        if (result) {
          try {
            let payments = await Payment.find({
              user: result.user?._id,
              event: result.event?._id,
              createdAt: { $lt: result?.createdAt },
              status: "paid",
            }).exec();
            let event = result?.event?.toObject();
            let { total, paid, due } = event.amount;
            let received = payments
              .filter((p) => p?.status === "paid")
              .reduce((accumulator, e) => {
                return accumulator + e.amountPaid / 100;
              }, 0);
            received += result.amountPaid / 100;
            let transactions = result.transactions || [];
            if (
              !["cash", "upi", "bank-transfer"].includes(
                result.paymentMethod
              ) &&
              transactions.length == 0
            ) {
              transactions = await GetPaymentTransactions({
                order_id: result?.razporPayId,
              });
            }
            createInvoice(
              {
                ...result.toObject(),
                stats: { total, paid, due, received },
                transactions,
              },
              res
            );
          } catch (error) {
            res.status(400).send({ message: "error_try", error });
          }
        } else {
          res.status(404).send({ message: "Invoice not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({ message: "error" });
  }
};

module.exports = {
  CreateNewPayment,
  UpdatePayment,
  GetAllPayments,
  GetAllTransactions,
  GetInvoice,
};

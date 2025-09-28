const Razorpay = require("razorpay");
const Payment = require("../models/Payment");

var instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const CreatePayment = ({ _id }) => {
  return new Promise((resolve, reject) => {
    Payment.findById({ _id })
      .then((result) => {
        if (!result) {
          reject({ message: "Not Found!" });
        } else {
          const { amount, user, paymentFor, event } = result;
          const options = {
            amount,
            currency: "INR",
            receipt: _id,
            notes: { user, paymentFor, event: event || "" },
            partial_payment: false, // indicates whether the customer can make a partial payment.
          };
          instance.orders.create(options, function (err, order) {
            if (err) {
              reject({ message: "error", err });
            } else {
              Payment.findByIdAndUpdate(
                { _id },
                { $set: { status: order.status, razporPayId: order.id } }
              )
                .then((result) => {
                  resolve(order);
                })
                .catch((error) => {
                  reject({ message: "error", error });
                });
            }
          });
        }
      })
      .catch((error) => {
        reject({ message: "error", error });
      });
  });
};

const GetPaymentStatus = ({ order_id, response }) => {
  return new Promise((resolve, reject) => {
    instance.orders.fetch(order_id, function (err, order) {
      if (err) {
        reject({ message: "error", err });
      } else {
        Payment.findOneAndUpdate(
          { razporPayId: order_id },
          {
            $set: {
              status: order.status,
              amountPaid: order.amount_paid,
              amountDue: order.amount_due,
            },
            $addToSet: { response },
          }
        )
          .then((result) => {
            resolve(order);
          })
          .catch((error) => {
            reject({ message: "error", error });
          });
      }
    });
  });
};

const GetPaymentTransactions = ({ order_id }) => {
  return new Promise((resolve, reject) => {
    instance.orders.fetchPayments(order_id, function (err, transactions) {
      if (err) {
        reject({ message: "error", err });
      } else {
        Payment.findOneAndUpdate(
          { razporPayId: order_id },
          { $set: { transactions: transactions.items } }
        );
        resolve(transactions.items);
      }
    });
  });
};

module.exports = {
  CreatePayment,
  GetPaymentStatus,
  GetPaymentTransactions,
};

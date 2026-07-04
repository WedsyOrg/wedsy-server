const Razorpay = require("razorpay");
const Payment = require("../models/Payment");

/** Log Razorpay / payment errors without secrets. */
function logPaymentError(context, detail) {
  const err = detail?.err ?? detail?.error ?? detail;
  const safe = {
    context,
    statusCode: err?.statusCode,
    code: err?.error?.code ?? err?.code,
    description: err?.error?.description ?? err?.description,
    message: err?.error?.message ?? err?.message,
    paymentMongoId:
      detail?.paymentMongoId ?? detail?.paymentId ?? detail?._id,
  };
  console.error("[payment:error]", JSON.stringify(safe));
  if (err && typeof err === "object") {
    try {
      console.error("[payment:error] detail", JSON.stringify(err).slice(0, 2500));
    } catch (_) {
      console.error("[payment:error] detail (non-serializable)", err);
    }
  }
}

const _keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
const _keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
console.log("[payment:config] Razorpay", {
  keyIdPrefix: _keyId ? `${_keyId.slice(0, 10)}…` : "(empty)",
  keyIdLength: _keyId.length,
  keySecretSet: Boolean(_keySecret),
});

// MB7a — dormant-until-armed: the Razorpay SDK throws at construction when
// key_id is empty, so build it LAZILY (only when configured). This lets the
// server boot with no keys (dormant), mirroring Google/Meta. Existing callers
// (orders.create/fetch) get the instance on demand via getInstance().
const razorpayConfigured = () =>
  !!((process.env.RAZORPAY_KEY_ID || "").trim() && (process.env.RAZORPAY_KEY_SECRET || "").trim());

let _instance = null;
const getInstance = () => {
  if (_instance) return _instance;
  if (!razorpayConfigured()) {
    throw Object.assign(new Error("Razorpay is not configured (RAZORPAY_KEY_ID/SECRET unset)"), { statusCode: 503 });
  }
  _instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return _instance;
};

const CreatePayment = ({ _id }) => {
  return new Promise((resolve, reject) => {
    Payment.findById({ _id })
      .then((result) => {
        if (!result) {
          logPaymentError("CreatePayment:payment_not_found", { _id });
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
          getInstance().orders.create(options, function (err, order) {
            if (err) {
              logPaymentError("CreatePayment:razorpay_orders_create", {
                err,
                paymentMongoId: String(_id),
                amount: options.amount,
                currency: options.currency,
              });
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
                  logPaymentError("CreatePayment:update_payment_doc", {
                    error,
                    paymentMongoId: String(_id),
                  });
                  reject({ message: "error", error });
                });
            }
          });
        }
      })
      .catch((error) => {
        logPaymentError("CreatePayment:findById", { error, paymentMongoId: String(_id) });
        reject({ message: "error", error });
      });
  });
};

const GetPaymentStatus = ({ order_id, response }) => {
  return new Promise((resolve, reject) => {
    getInstance().orders.fetch(order_id, function (err, order) {
      if (err) {
        logPaymentError("GetPaymentStatus:razorpay_orders_fetch", { err, order_id });
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
            logPaymentError("GetPaymentStatus:db_update", { error, order_id });
            reject({ message: "error", error });
          });
      }
    });
  });
};

const GetPaymentTransactions = ({ order_id }) => {
  return new Promise((resolve, reject) => {
    getInstance().orders.fetchPayments(order_id, function (err, transactions) {
      if (err) {
        logPaymentError("GetPaymentTransactions:razorpay", { err, order_id });
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

// Razorpay mode: dormant (unset), live (rzp_live_*), else test. Test keys
// operate in Razorpay test mode automatically; going live = swapping prod keys.
const razorpayMode = () => {
  if (!razorpayConfigured()) return "dormant";
  return (process.env.RAZORPAY_KEY_ID || "").trim().startsWith("rzp_live_") ? "live" : "test";
};

// Create a Razorpay payment link for a milestone. amountPaise is in PAISE.
// Dormant when keys are unset → returns { dormant: true } (no API call), so the
// flow works pre-config and the sales lead chases manually. Never throws.
const CreatePaymentLink = async ({ amountPaise, description, customer = {}, reference }) => {
  if (!razorpayConfigured()) return { dormant: true, mode: "dormant" };
  try {
    const link = await getInstance().paymentLink.create({
      amount: amountPaise,
      currency: "INR",
      accept_partial: false,
      description: description || "Wedsy payment",
      reference_id: reference || undefined,
      customer: { name: customer.name || "", contact: customer.contact || "", email: customer.email || "" },
      notify: { sms: false, email: false }, // we chase via our own channels
      reminder_enable: false,
    });
    return { dormant: false, mode: razorpayMode(), id: link.id, url: link.short_url, raw: link };
  } catch (error) {
    logPaymentError("CreatePaymentLink", { error });
    return { dormant: false, mode: razorpayMode(), error: error?.error?.description || error?.message || "link creation failed" };
  }
};

module.exports = {
  CreatePayment,
  GetPaymentStatus,
  GetPaymentTransactions,
  CreatePaymentLink,
  razorpayConfigured,
  razorpayMode,
};

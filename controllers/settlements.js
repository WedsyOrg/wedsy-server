const axios = require("axios");
const Vendor = require("../models/Vendor");
const Order = require("../models/Order");
const Settlement = require("../models/Settlement");

const CreateVendorSettlementAccount = (req, res) => {
  const { user_id, user } = req.auth;
  const {
    legal_business_name,
    business_type,
    category,
    subcategory,
    addresses,
    pan,
    gst,
    phone,
  } = req.body;
  if (
    !legal_business_name ||
    !business_type ||
    !category ||
    !subcategory ||
    addresses === null ||
    addresses === undefined
  ) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    const base64Token = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");
    // Format phone number for Razorpay (remove + prefix)
    console.log("Phone number debugging:");
    console.log("- phone from request body:", phone);
    console.log("- user.phone from profile:", user?.phone);
    
    // Prioritize phone from request body, then format it
    let phoneToUse = phone || user?.phone;
    const formattedPhone = phoneToUse?.replace('+', '') || phoneToUse;
    console.log("- phone to use:", phoneToUse);
    console.log("- formatted phone:", formattedPhone);
    
    let data = JSON.stringify({
      email: user?.email, //: "gaurav.kumar@example.com",
      phone: formattedPhone, //: "9000090000",
      type: "route",
      //   reference_id: user_id, //"124124",
      legal_business_name, //: "Acme Corp",
      business_type, //: "partnership",
      contact_name: user?.name, // "Gaurav Kumar",
      profile: {
        category, //: "healthcare",
        subcategory, //: "clinic",
        addresses, //:
        // {
        //   registered: {
        //     street1: "507, Koramangala 1st block",
        //     street2: "MG Road",
        //     city: "Bengaluru",
        //     state: "KARNATAKA",
        //     postal_code: "560034",
        //     country: "IN",
        //   },
        // },
      },
      legal_info: {
        pan: pan ?? "", //: "AAACL1234C",
        gst: gst ?? "", //: "18AABCU9603R1ZM",
      },
    });
    
    console.log("Data being sent to Razorpay:", JSON.parse(data));
    console.log("Business type being sent:", business_type);
    console.log("PAN being sent:", pan);
    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: "https://api.razorpay.com/v2/accounts",
      headers: {
        "Content-type": "application/json",
        Authorization: `Basic ${base64Token}`,
      },
      data: data,
    };
    axios
      .request(config)
      .then((response) => {
        console.log(response.data);
        return response.data;
      })
      .then((result) => {
        if (result?.id && result?.status === "created") {
          Vendor.findByIdAndUpdate(
            { _id: user_id },
            {
              $set: {
                razorPay_accountId: result?.id,
                razporPay_info: JSON.parse(data),
              },
            }
          ).then((r) => {
            if (!r) {
              res.status(404).send();
            } else {
              res.status(200).send({ message: "success" });
            }
          });
        } else {
          res.status(400).send({ message: "error" });
        }
      })
      .catch((error) => {
        console.log("Razorpay API Error Details:");
        console.log("Status:", error.response?.status);
        console.log("Error Data:", JSON.stringify(error.response?.data, null, 2));
        console.log("Request Data:", data);
        console.log("Full Error:", error);
        res.status(400).send({ 
          message: "Razorpay API Error", 
          error: error.response?.data || error.message,
          details: error.response?.data
        });
      });
  }
};

const CreateVendorSettlementProduct = (req, res) => {
  const { user_id, user } = req.auth;
  if (user?.razorPay_productId || !user?.razorPay_accountId) {
    res.status(400).send({ message: "Invalid" });
  } else {
    const base64Token = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");
    let data = JSON.stringify({
      product_name: "route",
      tnc_accepted: true,
    });
    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `https://api.razorpay.com/v2/accounts/${user?.razorPay_accountId}/products`,
      headers: {
        "Content-type": "application/json",
        Authorization: `Basic ${base64Token}`,
      },
      data: data,
    };
    axios
      .request(config)
      .then((response) => {
        // console.log(response.data);
        return response.data;
      })
      .then((result) => {
        if (result?.id) {
          //   console.log(result?.activation_status);
          Vendor.findByIdAndUpdate(
            { _id: user_id },
            {
              $set: {
                razorPay_productId: result?.id,
                razporPay_product_status: result?.activation_status,
              },
            }
          ).then((r) => {
            if (!r) {
              res.status(404).send();
            } else {
              res.status(200).send({ message: "success" });
            }
          });
        } else {
          res.status(400).send({ message: "error" });
        }
      })
      .catch((error) => {
        console.log("Razorpay API Error Details:");
        console.log("Status:", error.response?.status);
        console.log("Error Data:", JSON.stringify(error.response?.data, null, 2));
        console.log("Request Data:", data);
        console.log("Full Error:", error);
        res.status(400).send({ 
          message: "Razorpay API Error", 
          error: error.response?.data || error.message,
          details: error.response?.data
        });
      });
  }
};

const UpdateVendorSettlementProduct = (req, res) => {
  const { user_id, user } = req.auth;
  const { account_number, ifsc_code, beneficiary_name } = req.body;
  if (!user?.razorPay_productId || !user?.razorPay_accountId) {
    res.status(400).send({ message: "Invalid" });
  } else {
    const base64Token = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");
    let data = JSON.stringify({
      settlements: {
        account_number,
        ifsc_code,
        beneficiary_name,
      },
      tnc_accepted: true,
    });
    let config = {
      method: "patch",
      maxBodyLength: Infinity,
      url: `https://api.razorpay.com/v2/accounts/${user?.razorPay_accountId}/products/${user?.razorPay_productId}/`,
      headers: {
        "Content-type": "application/json",
        Authorization: `Basic ${base64Token}`,
      },
      data: data,
    };
    axios
      .request(config)
      .then((response) => {
        // console.log(response.data);
        return response.data;
      })
      .then((result) => {
        data = JSON.stringify({
          name: beneficiary_name,
          email: user?.email,
        });
        config = {
          method: "post",
          maxBodyLength: Infinity,
          url: `https://api.razorpay.com/v2/accounts/${user?.razorPay_accountId}/stakeholders`,
          headers: {
            "Content-type": "application/json",
            Authorization: `Basic ${base64Token}`,
          },
          data: data,
        };
        axios
          .request(config)
          .then((response) => {
            // console.log(response.data);
            return response.data;
          })
          .then((r) => {
            Vendor.findByIdAndUpdate(
              { _id: user_id },
              {
                $set: {
                  razporPay_product_info: {
                    settlements: {
                      account_number,
                      ifsc_code,
                      beneficiary_name,
                    },
                    tnc_accepted: true,
                  },
                  razporPay_product_status: result?.activation_status,
                  razorPay_setup_completed: true,
                  paymentCompleted: true,
                },
              }
            ).then((r) => {
              if (!r) {
                res.status(404).send();
              } else {
                res.status(200).send({ message: "success" });
              }
            });
          })
          .catch((error) => {
            console.log("Error:", error.response?.data, data);
            res.status(400).send({ message: "error", error });
          });
      })
      .catch((error) => {
        console.log("Razorpay API Error Details:");
        console.log("Status:", error.response?.status);
        console.log("Error Data:", JSON.stringify(error.response?.data, null, 2));
        console.log("Request Data:", data);
        console.log("Full Error:", error);
        res.status(400).send({ 
          message: "Razorpay API Error", 
          error: error.response?.data || error.message,
          details: error.response?.data
        });
      });
  }
};

const CreateSettlement = (req, res) => {
  const { vendor, order, amount, vendorRazorPayId } = req.body;
  if (!vendor || !order || amount <= 0 || !vendorRazorPayId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    const base64Token = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");
    let data = JSON.stringify({
      account: vendorRazorPayId,
      amount: amount * 100,
      currency: "INR",
    });
    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: "https://api.razorpay.com/v1/transfers",
      headers: {
        "content-type": "application/json",
        Authorization: `Basic ${base64Token}`,
      },
      data: data,
    };
    axios
      .request(config)
      .then((response) => {
        console.log(response.data);
        return response.data;
      })
      .then((result) => {
        // console.log(JSON.stringify(response.data));
        if (result.id) {
          new Settlement({
            vendor,
            amount,
            amountPaid: amount,
            amountDue: 0,
            status: result.status,
            order,
            razporPayId: result?.id,
          })
            .save()
            .then(async (result) => {
              const tempOrder = await Order.findById(order);
              if (!tempOrder) {
                return res.status(404).json({ message: "Order not found" });
              }
              tempOrder.amount.receivedByWedsy =
                tempOrder.amount.total - amount;
              tempOrder.amount.receivedByVendor = amount;
              const updatedOrder = await tempOrder.save();
              res.status(201).send({ message: "success" });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          res.status(400).send({ message: "error" });
        }
      })
      .catch((error) => {
        console.log(error);
      });
  }
};

const GetSettlements = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  if (isVendor) {
    Settlement.find({ vendor: user_id })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (isAdmin) {
    Settlement.find({})
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else {
    res.status(400).send({ message: "error" });
  }
};

const GetSettlementAccountStatus = (req, res) => {
  const { user, user_id, isAdmin, isVendor } = req.auth;
  const { checkStatus } = req.query;
  if (checkStatus == "true") {
    if (isVendor) {
      if (user?.razorPay_accountId) {
        if (user?.razorPay_productId) {
          res.status(200).send({
            message: "success",
            accountCreated: true,
            productCreated: true,
            accountDetails: user?.razporPay_info,
            razorPay_accountId: user?.razorPay_accountId,
            razorPay_productId: user?.razorPay_productId,
            razporPay_product_info: user?.razporPay_product_info,
            razporPay_product_status: user?.razporPay_product_status,
            razorPay_setup_completed: user?.razorPay_setup_completed,
          });
        } else {
          res.status(200).send({
            message: "success",
            accountCreated: true,
            productCreated: false,
            accountDetails: user?.razporPay_info,
            razorPay_accountId: user?.razorPay_accountId,
          });
        }
      } else {
        res.status(200).send({ message: "success", accountCreated: false });
      }
    } else if (isAdmin) {
      const { vendorId } = req.body;
      Vendor.findById({ _id: vendorId })
        .then((result) => {
          if (!result) {
            res.status(404).send();
          } else {
            if (result?.razorPay_accountId) {
              if (result?.razorPay_productId) {
                res.status(200).send({
                  message: "success",
                  accountCreated: true,
                  productCreated: true,
                  accountDetails: result?.razporPay_info,
                  razorPay_accountId: result?.razorPay_accountId,
                  razorPay_productId: result?.razorPay_productId,
                });
              } else {
                res.status(200).send({
                  message: "success",
                  accountCreated: true,
                  productCreated: false,
                  accountDetails: result?.razporPay_info,
                  razorPay_accountId: result?.razorPay_accountId,
                });
              }
            } else {
              res
                .status(200)
                .send({ message: "success", accountCreated: false });
            }
          }
        })
        .catch((error) => {
          console.log("Error", error);
          res.status(400).send({ message: "error", error });
        });
    } else {
      res.status(400).send({ message: "error" });
    }
  } else {
    res.status(400).send({ message: "error" });
  }
};

module.exports = {
  CreateVendorSettlementAccount,
  GetSettlementAccountStatus,
  CreateVendorSettlementProduct,
  UpdateVendorSettlementProduct,
  CreateSettlement,
  GetSettlements,
};

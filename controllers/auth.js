const User = require("../models/User");
const Event = require("../models/Event");
const { VerifyOTP, SendOTP } = require("../utils/otp");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../config/jwt");
const Admin = require("../models/Admin");
const Vendor = require("../models/Vendor");
const { CheckHash, CreateHash } = require("../utils/password");
const { SendUpdate } = require("../utils/update");
const Enquiry = require("../models/Enquiry");

const Login = (req, res) => {
  const { name, phone, Otp, ReferenceId, source } = req.body;
  if (phone.length !== 13 || !Otp || !ReferenceId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
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
                res.send({
                  message: "Login Successful",
                  token,
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
                      verified: true,
                      source: source || "User Signup (Account Creation)",
                      additionalInfo: {},
                    })
                      .save()
                      .then((result) => {})
                      .catch((error) => {});
                    SendUpdate({
                      channels: ["SMS", "Whatsapp"],
                      message: "New User",
                      parameters: { name, phone },
                    });
                    res.send({
                      message: "Login Successful",
                      token,
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
  }
};

const VendorLogin = (req, res) => {
  const { phone, Otp, ReferenceId } = req.body;
  if (phone.length !== 13 || !Otp || !ReferenceId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VerifyOTP(phone, ReferenceId, Otp)
      .then((result) => {
        if (result.Valid === true) {
          Vendor.findOne({ phone })
            .then((user) => {
              if (user) {
                const { _id } = user;
                const token = jwt.sign(
                  { _id, isVendor: true },
                  process.env.JWT_SECRET,
                  jwtConfig
                );
                res.send({
                  message: "Login Successful",
                  token,
                });
              } else {
                res.status(404).send({ message: "User not found" });
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
  }
};

const AdminLogin = (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Admin.findOne({ email })
      .then(async (user) => {
        if (user) {
          const { _id } = user;
          if (
            password &&
            user.password &&
            (await CheckHash(password, user.password))
          ) {
            const token = jwt.sign(
              { _id, isAdmin: true },
              process.env.JWT_SECRET,
              jwtConfig
            );
            res.send({
              message: "Login Successful",
              token,
            });
          } else {
            res.status(401).send({ message: "Wrong Credentials" });
          }
        } else if (false && req.body.phone && req.body.name && req.body.roles) {
          const hashedPassword = await CreateHash(password);
          new Admin({
            name: req.body.name,
            phone: req.body.phone,
            email,
            password: hashedPassword,
            roles: req.body.roles,
          })
            .save()
            .then((result) => {
              const { _id } = result;
              const token = jwt.sign(
                { _id, isAdmin: true },
                process.env.JWT_SECRET,
                jwtConfig
              );
              res.send({
                message: "Login Successful",
                token,
              });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          res.status(404).send({ message: "User not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const Get = async (req, res) => {
  const { user, user_id } = req.auth;
  const { name, phone, email } = user;
  const event = await Event.find({ user: user_id }, "_id")
    .then((result) => result[0]?._id || "")
    .catch((e) => {});
  res.send({ name, phone, email, event: event || null });
};

const GetAdmin = (req, res) => {
  const { user } = req.auth;
  const { name, phone, email, roles } = user;
  res.send({ name, phone, email, roles });
};

const GetVendor = (req, res) => {
  const { user, user_id } = req.auth;
  const {
    name,
    phone,
    email,
    category,
    notifications,
    accountDetails,
    prices,
    gallery,
    other,
    businessAddress,
    businessName,
    businessDescription,
    speciality,
    servicesOffered,
    profileCompleted,
    paymentCompleted,
    documents,
  } = user;
  const { groomMakeup, onlyHairStyling } = other;
  const { searchFor } = req.query;
  if (searchFor) {
    if (searchFor === "accountDetails") {
      res.send({ accountDetails });
    } else if (searchFor === "prices") {
      res.send({ prices });
    } else if (searchFor === "gallery") {
      res.send({ gallery, temp: user_id });
    } else if (searchFor === "other") {
      res.send({ other });
    } else if (searchFor === "businessAddress") {
      res.send({ businessAddress });
    } else if (searchFor === "profile") {
      res.send({
        businessName,
        businessDescription,
        speciality,
        servicesOffered,
        groomMakeup,
        onlyHairStyling,
      });
    } else if (searchFor === "documents") {
      res.send({ documents });
    }
  } else {
    res.send({
      name,
      phone,
      email,
      notifications,
      category,
      profileCompleted,
      paymentCompleted,
    });
  }
};
const GetOTP = (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 13) {
    res.status(400).send({ message: "incorrect phone number" });
  } else {
    SendOTP(phone)
      .then((result) => {
        res.send({
          message: "OTP sent successfully",
          ReferenceId: result.ReferenceId,
        });
      })
      .catch((err) => {
        res.status(400).send({ message: "error", error: err });
      });
  }
};

module.exports = {
  AdminLogin,
  GetAdmin,
  Login,
  Get,
  GetOTP,
  VendorLogin,
  GetVendor,
};

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
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Bidding = require("../models/Bidding");
const BiddingBooking = require("../models/BiddingBooking");
const Chat = require("../models/Chat");
const Notification = require("../models/Notification");
const VendorReview = require("../models/VendorReview");
const VendorStatLog = require("../models/VendorStatLog");
const UserSavedAddress = require("../models/UserSavedAddress");
const PaymentReminder = require("../models/PaymentReminder");

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
                if (user.blocked) {
                  return res
                    .status(403)
                    .send({ message: "UserBlocked", error: "User is blocked" });
                }
                if (user.deleted) {
                  return res
                    .status(403)
                    .send({ message: "UserDeleted", error: "User account has been deleted" });
                }
                const { _id } = user;
                const token = jwt.sign(
                  { _id },
                  process.env.JWT_SECRET,
                  jwtConfig
                );
                // Check if enquiry already exists before creating
                Enquiry.findOne({ phone })
                  .then((existingEnquiry) => {
                    if (!existingEnquiry) {
                      // Only create enquiry if it doesn't exist
                      new Enquiry({
                        name: name || user.name || "",
                        phone,
                        verified: true,
                        source: source || "User Signup (Account Creation)",
                        additionalInfo: {},
                      })
                        .save()
                        .then((result) => {})
                        .catch((error) => {});
                    }
                  })
                  .catch((error) => {});
                res.send({
                  message: "Login Successful",
                  token,
                });
              } else {
                new User({
                  name: name || "",
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
                    // Check if enquiry already exists before creating
                    Enquiry.findOne({ phone })
                      .then((existingEnquiry) => {
                        if (!existingEnquiry) {
                          new Enquiry({
                            name: name || "",
                            phone,
                            verified: true,
                            source: source || "User Signup (Account Creation)",
                            additionalInfo: {},
                          })
                            .save()
                            .then((result) => {})
                            .catch((error) => {});
                        }
                      })
                      .catch((error) => {});
                    SendUpdate({
                      channels: ["SMS", "Whatsapp"],
                      message: "New User",
                      parameters: { name: name || "", phone },
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

// Block / unblock a user (admin only)
const BlockUser = (req, res) => {
  const { user_id, isAdmin } = req.auth || {};
  const { userId, blocked } = req.body || {};

  if (!isAdmin) {
    return res.status(403).send({ message: "Access denied" });
  }
  if (!userId) {
    return res.status(400).send({ message: "userId is required" });
  }

  User.findByIdAndUpdate(
    { _id: userId },
    { $set: { blocked: blocked !== false } },
    { new: true }
  )
    .then((user) => {
      if (!user) {
        res.status(404).send({ message: "User not found" });
      } else {
        res.send({ message: "success", blocked: user.blocked });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

// Delete user account (admin only)
// mode = "soft" (default) or "hard"
const DeleteUserAccount = async (req, res) => {
  const { isAdmin } = req.auth || {};
  const { userId, mode = "soft" } = req.body || {};

  if (!isAdmin) {
    return res.status(403).send({ message: "Access denied" });
  }
  if (!userId) {
    return res.status(400).send({ message: "userId is required" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    // HARD DELETE: remove user and all linked data
    if (mode === "hard") {
      await Promise.all([
        Event.deleteMany({ user: userId }),
        Order.deleteMany({ user: userId }),
        Payment.deleteMany({ user: userId }),
        Bidding.deleteMany({ user: userId }),
        BiddingBooking.deleteMany({ user: userId }),
        Chat.deleteMany({ user: userId }),
        VendorStatLog.deleteMany({ user: userId }),
        VendorReview.deleteMany({ user: userId }),
        UserSavedAddress.deleteMany({ user: userId }),
        PaymentReminder.deleteMany({ user: userId }),
        Notification.deleteMany({ user: userId }),
      ]);

      await User.findByIdAndDelete(userId);

      return res.send({ message: "success", mode: "hard" });
    }

    // SOFT DELETE: keep history, but disable and anonymize account
    // Store original data before anonymizing for restore capability
    if (!user.originalName) {
      user.originalName = user.name;
      user.originalEmail = user.email;
      user.originalPhone = user.phone;
    }

    user.blocked = true;
    user.deleted = true;
    user.name = "Deleted User";
    user.email = "";
    user.phone = `deleted-${user.phone}`;

    await user.save();

    return res.send({ message: "success", mode: "soft" });
  } catch (error) {
    console.error("DeleteUserAccount error:", error);
    return res
      .status(400)
      .send({ message: "error", error: error.message || error });
  }
};

// Restore a soft-deleted user account (admin only)
const RestoreUserAccount = async (req, res) => {
  const { isAdmin } = req.auth || {};
  const { userId } = req.body || {};

  if (!isAdmin) {
    return res.status(403).send({ message: "Access denied" });
  }
  if (!userId) {
    return res.status(400).send({ message: "userId is required" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    // Check if user is actually deleted
    if (!user.deleted) {
      return res.status(400).send({ message: "User is not deleted" });
    }

    // Check if we have original data to restore
    if (!user.originalPhone) {
      return res.status(400).send({ 
        message: "Cannot restore: original user data not found. User may have been hard deleted." 
      });
    }

    // Restore original data
    user.name = user.originalName || user.name;
    user.email = user.originalEmail || user.email;
    user.phone = user.originalPhone;
    user.deleted = false;
    // Note: blocked status is kept as-is (admin can unblock separately if needed)
    // Or uncomment below to auto-unblock on restore:
    // user.blocked = false;

    // Clear original data fields after restore
    user.originalName = "";
    user.originalEmail = "";
    user.originalPhone = "";

    await user.save();

    return res.send({ 
      message: "success", 
      restored: true,
      user: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        blocked: user.blocked
      }
    });
  } catch (error) {
    console.error("RestoreUserAccount error:", error);
    return res
      .status(400)
      .send({ message: "error", error: error.message || error });
  }
};

const VendorLogin = (req, res) => {
  const { phone, Otp, ReferenceId } = req.body;
  if (phone.length !== 13 || !Otp || !ReferenceId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    // Demo user bypass - check before normal OTP verification
    const DEMO_PHONE = "+919774358212";
    const DEMO_OTP = "764587";
    
    // If demo phone and demo OTP match, skip OTP verification
    if (phone === DEMO_PHONE && Otp === DEMO_OTP) {
      Vendor.findOne({ phone })
        .then((user) => {
          if (user) {
            if (user.deleted) {
              return res
                .status(403)
                .send({ message: "VendorDeleted", error: "Vendor account has been deleted" });
            }
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
            // Create demo vendor account if it doesn't exist
            new Vendor({
              name: "Demo Vendor",
              phone: +919774358212,
              email: "demo@vendor.com",
              gender: "Male",
              category: "Wedding Makeup",
            })
              .save()
              .then((result) => {
                const { _id } = result;
                const token = jwt.sign(
                  { _id, isVendor: true },
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
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
      return; // Exit early, don't proceed with normal OTP verification
    }

    // Normal OTP verification flow for all other users
    VerifyOTP(phone, ReferenceId, Otp)
      .then((result) => {
        if (result.Valid === true) {
          Vendor.findOne({ phone })
            .then((user) => {
              if (user) {
                if (user.deleted) {
                  return res
                    .status(403)
                    .send({ message: "VendorDeleted", error: "Vendor account has been deleted" });
                }
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

// Delete vendor account (soft delete only)
// Vendor can delete their own account, Admin can delete any vendor
const DeleteVendorAccount = async (req, res) => {
  const { isAdmin, isVendor, user_id } = req.auth || {};
  const { vendorId } = req.body || {};

  // Determine which vendor to delete
  const targetVendorId = vendorId || (isVendor ? user_id : null);

  if (!targetVendorId) {
    return res.status(400).send({ message: "vendorId is required" });
  }

  // Authorization check: Vendor can only delete self, Admin can delete any
  if (!isAdmin && (!isVendor || user_id !== targetVendorId)) {
    return res.status(403).send({ message: "Access denied" });
  }

  try {
    const vendor = await Vendor.findById(targetVendorId);
    if (!vendor) {
      return res.status(404).send({ message: "Vendor not found" });
    }

    // Check if vendor is already deleted
    if (vendor.deleted) {
      return res.status(400).send({ message: "Vendor already deleted" });
    }

    // SOFT DELETE: keep history, but disable and anonymize account
    // Store original data before anonymizing for restore capability
    if (!vendor.originalName) {
      vendor.originalName = vendor.name;
      vendor.originalEmail = vendor.email;
      vendor.originalPhone = vendor.phone;
    }

    vendor.blocked = true;
    vendor.deleted = true;
    vendor.name = "Deleted Vendor";
    vendor.email = `deleted-${vendor.email}`; // Use placeholder instead of empty string to satisfy required validation
    vendor.phone = `deleted-${vendor.phone}`;

    await vendor.save();

    return res.send({ message: "success" });
  } catch (error) {
    console.error("DeleteVendorAccount error:", error);
    return res
      .status(400)
      .send({ message: "error", error: error.message || error });
  }
};

// Restore a soft-deleted vendor account (admin only)
const RestoreVendorAccount = async (req, res) => {
  const { isAdmin } = req.auth || {};
  const { vendorId } = req.body || {};

  if (!isAdmin) {
    return res.status(403).send({ message: "Access denied" });
  }
  if (!vendorId) {
    return res.status(400).send({ message: "vendorId is required" });
  }

  try {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) {
      return res.status(404).send({ message: "Vendor not found" });
    }

    // Check if vendor is actually deleted
    if (!vendor.deleted) {
      return res.status(400).send({ message: "Vendor is not deleted" });
    }

    // Check if we have original data to restore
    if (!vendor.originalPhone) {
      return res.status(400).send({ 
        message: "Cannot restore: original vendor data not found." 
      });
    }

    // Restore original data
    vendor.name = vendor.originalName || vendor.name;
    vendor.email = vendor.originalEmail || vendor.email;
    vendor.phone = vendor.originalPhone;
    vendor.deleted = false;
    // Note: blocked status is kept as-is (admin can unblock separately if needed)

    // Clear original data fields after restore
    vendor.originalName = "";
    vendor.originalEmail = "";
    vendor.originalPhone = "";

    await vendor.save();

    return res.send({ 
      message: "success", 
      restored: true,
      vendor: {
        name: vendor.name,
        phone: vendor.phone,
        email: vendor.email,
        blocked: vendor.blocked
      }
    });
  } catch (error) {
    console.error("RestoreVendorAccount error:", error);
    return res
      .status(400)
      .send({ message: "error", error: error.message || error });
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
        name,
        phone,
        email,
        businessName,
        businessDescription,
        speciality,
        servicesOffered,
        groomMakeup,
        onlyHairStyling,
        businessAddress,
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
  BlockUser,
  DeleteUserAccount,
  RestoreUserAccount,
  DeleteVendorAccount,
  RestoreVendorAccount,
};

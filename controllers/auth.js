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
              // Settings Suite Slice 9: client-side gate; token is still issued.
              mustResetPassword: user.mustResetPassword === true,
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
  res.send({
    name,
    phone,
    email,
    roles,
    // Settings Suite Slice 9: AdminContext routes flagged admins to /set-password.
    mustResetPassword: user.mustResetPassword === true,
  });
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
    socialMedia,
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
        socialMedia,
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


// ── Password reset (Lifecycle Slice G) ───────────────────────────────────────
const crypto = require("crypto");
const NotificationService = require("../services/NotificationService");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// POST /auth/admin/forgot — ALWAYS responds with the same generic 200 so account
// existence can never be probed. Ships dark until MAILJET_TEMPLATE_RESET is set.
const ForgotPassword = async (req, res) => {
  const generic = { message: "If that account exists, a reset link was sent." };
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(200).send(generic);
    }
    const admin = await Admin.findOne({ email: email.trim() });
    if (!admin) {
      return res.status(200).send(generic);
    }
    const token = crypto.randomBytes(32).toString("hex");
    admin.resetToken = sha256(token);
    admin.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await admin.save();

    const templateId = process.env.MAILJET_TEMPLATE_RESET;
    if (!templateId) {
      console.warn(
        "[auth] MAILJET_TEMPLATE_RESET is not set — reset email NOT sent (dark ship). Token stored; flow testable via DB."
      );
      return res.status(200).send(generic);
    }
    const base = process.env.OS_FRONTEND_URL || "https://os.wedsy.in";
    const resetUrl = `${base}/reset-password?token=${token}&email=${encodeURIComponent(
      admin.email
    )}`;
    NotificationService.sendEmail(
      admin.email,
      Number(templateId),
      { name: admin.name, resetUrl, expiresIn: "30 minutes" },
      admin.name
    ).catch((e) => console.error("[auth] reset email failed:", e.message));
    return res.status(200).send(generic);
  } catch (error) {
    console.error("[auth] ForgotPassword error:", error.message);
    // Still generic — never leak state through errors.
    return res.status(200).send(generic);
  }
};

// POST /auth/admin/reset — one generic 400 on ANY failure (no oracle).
const ResetPassword = async (req, res) => {
  try {
    const { email, token, newPassword } = req.body || {};
    const fail = () =>
      res.status(400).send({ message: "Invalid or expired reset link" });
    if (!email || !token || !newPassword || typeof newPassword !== "string") {
      return fail();
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .send({ message: "Password must be at least 8 characters" });
    }
    const admin = await Admin.findOne({ email: String(email).trim() });
    if (
      !admin ||
      !admin.resetToken ||
      !admin.resetTokenExpiresAt ||
      admin.resetTokenExpiresAt < new Date() ||
      admin.resetToken !== sha256(String(token))
    ) {
      return fail();
    }
    admin.password = await CreateHash(newPassword);
    admin.resetToken = null;
    admin.resetTokenExpiresAt = null;
    await admin.save();
    console.log(`[auth] Password reset completed for admin ${admin._id}`);
    return res.status(200).send({ message: "Password updated. You can log in now." });
  } catch (error) {
    console.error("[auth] ResetPassword error:", error.message);
    return res.status(400).send({ message: "Invalid or expired reset link" });
  }
};


// POST /auth/admin/first-reset — the ONLY action allowed to a flagged admin.
// Min 8 chars, must differ from the current password; clears the flag.
const FirstResetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).send({ message: "Password must be at least 8 characters" });
    }
    const admin = await Admin.findById(req.auth.user_id);
    if (!admin) return res.status(401).send({ message: "invalid user" });
    if (await CheckHash(newPassword, admin.password)) {
      return res.status(400).send({ message: "New password cannot be the same as the current one" });
    }
    admin.password = await CreateHash(newPassword);
    admin.mustResetPassword = false;
    await admin.save();
    console.log(`[auth] First-login password set for admin ${admin._id}`);
    return res.status(200).send({ message: "Password updated" });
  } catch (error) {
    console.error("[auth] FirstResetPassword error:", error.message);
    return res.status(500).send({ message: "Server error" });
  }
};

// POST /auth/admin/change-password — SELF password change (Slice 1). Acts ONLY
// on req.auth.user_id, so it can never target another admin. Verifies the
// current password against the stored bcrypt hash, then validates + saves the
// new one. Never logs or returns password values.
const ChangeOwnPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      return res.status(400).send({ message: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).send({ message: "Password must be at least 8 characters" });
    }
    const admin = await Admin.findById(req.auth.user_id);
    if (!admin) return res.status(401).send({ message: "invalid user" });
    if (!admin.password || !(await CheckHash(currentPassword, admin.password))) {
      return res.status(401).send({ message: "Current password is incorrect" });
    }
    if (await CheckHash(newPassword, admin.password)) {
      return res.status(400).send({ message: "New password cannot be the same as the current one" });
    }
    admin.password = await CreateHash(newPassword);
    admin.mustResetPassword = false;
    await admin.save();
    console.log(`[auth] Password changed by admin ${admin._id}`);
    return res.status(200).send({ message: "Password updated" });
  } catch (error) {
    console.error("[auth] ChangeOwnPassword error:", error.message);
    return res.status(500).send({ message: "Server error" });
  }
};

// GET /auth/admin/permissions — the caller's resolved permission strings.
// Drives which Settings sections the frontend renders.
const GetPermissions = async (req, res) => {
  try {
    const admin = await Admin.findById(req.auth.user_id).lean();
    const { permissionsForAdmin, roleIdsOf } = require("../middlewares/requirePermission");
    const ids = roleIdsOf(admin);
    if (!admin || ids.length === 0) {
      return res.status(200).send({ permissions: [], roleNames: [] });
    }
    // RBAC v2: union of permissions across every role; roleNames lists all.
    const Role = require("../models/Role");
    const [permissions, roles] = await Promise.all([
      permissionsForAdmin(admin),
      Role.find({ _id: { $in: ids } }, { name: 1 }).lean(),
    ]);
    const roleNames = roles.map((r) => r.name);
    res.status(200).send({
      permissions,
      roleNames,
      roleName: roleNames[0] || null, // back-compat
    });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
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
  ForgotPassword,
  ResetPassword,
  GetPermissions,
  FirstResetPassword,
  ChangeOwnPassword,
};

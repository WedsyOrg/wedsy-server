const axios = require("axios");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../../config/jwt");
const OTP = require("../../models/OTP");
const Vendor = require("../../models/Vendor");

const sendInternationalOtp = async (req, res) => {
  const { phone, countryCode } = req.body || {};
  if (!phone || !countryCode) {
    return res.status(400).send({ message: "Failed to send OTP" });
  }

  try {
    const otp = Math.floor(10000 + Math.random() * 90000);
    const fullPhone = `${countryCode}${phone}`;
    const saved = await new OTP({ phone: fullPhone, otp }).save();

    // AiSensy is CANCELLED. This call could never succeed, and because it is
    // awaited inside the try, every international OTP request returned
    // HTTP 400 "Failed to send OTP" — signup was not degraded, it was dead.
    //
    // The domestic path (utils/otp.js) already sends this same "otp_verification"
    // template through the Meta Cloud API, so no new template was needed. The
    // button parameter mirrors that call site exactly: the template carries a
    // URL button that must be given the code as its variable.
    //
    // Digits only: utils/whatsapp.js passes `phone` straight to Meta as `to`,
    // and countryCode arrives with or without a leading "+" depending on caller.
    const sent = await sendWhatsApp(
      String(fullPhone).replace(/\D/g, ""),
      "otp_verification",
      [otp.toString()],
      { sub_type: "url", index: 0, parameters: [{ type: "text", text: otp.toString() }] }
    );

    // sendWhatsApp retries twice, writes a NotificationFailureLog and resolves
    // null on final failure — it never throws. So the failure must be checked.
    if (!sent) {
      return res.status(400).send({ message: "Failed to send OTP" });
    }

    return res.status(200).send({
      message: "OTP sent on WhatsApp",
      ReferenceId: saved._id,
    });
  } catch (err) {
    console.error(
      "[vendor sendInternationalOtp] failed:",
      err?.response?.data || err?.message || err
    );
    return res.status(400).send({ message: "Failed to send OTP" });
  }
};

const verifyInternationalOtp = async (req, res) => {
  const { phone, countryCode, otp, referenceId } = req.body || {};
  if (!phone || !countryCode || !otp || !referenceId) {
    return res.status(400).send({ message: "Invalid or expired OTP" });
  }

  try {
    const fullPhone = `${countryCode}${phone}`;
    const record = await OTP.findOneAndDelete({
      phone: fullPhone,
      otp: String(otp),
      _id: referenceId,
    });

    if (!record) {
      return res.status(400).send({ message: "Invalid or expired OTP" });
    }

    const vendor = await Vendor.findOne({ phone: fullPhone });
    if (!vendor) {
      return res.status(404).send({ message: "Vendor not found" });
    }
    if (vendor.deleted) {
      return res
        .status(403)
        .send({ message: "VendorDeleted", error: "Vendor account has been deleted" });
    }
    if (vendor.blocked) {
      return res
        .status(403)
        .send({ message: "VendorBlocked", error: "Vendor account is blocked" });
    }

    const token = jwt.sign(
      { _id: vendor._id, isVendor: true },
      process.env.JWT_SECRET,
      jwtConfig
    );
    return res.status(200).send({ token, message: "success" });
  } catch (err) {
    console.error(
      "[vendor verifyInternationalOtp] failed:",
      err?.message || err
    );
    return res.status(400).send({ message: "Invalid or expired OTP" });
  }
};

module.exports = { sendInternationalOtp, verifyInternationalOtp };

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

    await axios({
      method: "post",
      url: process.env.AISENSY_API_URL,
      headers: { "Content-Type": "application/json" },
      data: {
        apiKey: process.env.AISENSY_API_KEY,
        campaignName: "otp_verification",
        destination: fullPhone,
        userName: "User",
        templateParams: [otp.toString()],
      },
    });

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

const axios = require("axios");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../config/jwt");
const OTP = require("../models/OTP");
const User = require("../models/User");
const Enquiry = require("../models/Enquiry");

const SendInternationalOTP = async (req, res) => {
  const { phone, countryCode } = req.body || {};
  if (!phone || !countryCode) {
    return res.status(400).send({ message: "Failed to send OTP" });
  }

  const fullPhone = `${countryCode}${phone}`;

  // Capture unverified lead before sending OTP. Continue even if this fails —
  // lead capture is best-effort and must not block OTP delivery.
  // name: "" satisfies Enquiry's required-name validator on the insert path.
  try {
    await Enquiry.findOneAndUpdate(
      { phone: fullPhone },
      {
        phone: fullPhone,
        name: "",
        verified: false,
        source: "International Signup",
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.log("Lead save failed:", e.message);
  }

  try {
    const otp = Math.floor(10000 + Math.random() * 90000);
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
      "[SendInternationalOTP] failed:",
      err?.response?.data || err?.message || err
    );
    return res.status(400).send({ message: "Failed to send OTP" });
  }
};

const VerifyInternationalOTP = async (req, res) => {
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

    const user = await User.findOne({ phone: fullPhone });
    if (!user) {
      return res
        .status(200)
        .send({ userExists: false, message: "Account not found" });
    }

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

    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, jwtConfig);
    return res
      .status(200)
      .send({ userExists: true, token, message: "success" });
  } catch (err) {
    console.error(
      "[VerifyInternationalOTP] failed:",
      err?.message || err
    );
    return res.status(400).send({ message: "Invalid or expired OTP" });
  }
};

const SignupInternational = async (req, res) => {
  const { phone, countryCode, name, email } = req.body || {};
  if (!phone || !countryCode || !name || !email) {
    return res.status(400).send({ message: "Missing required fields" });
  }

  const fullPhone = `${countryCode}${phone}`;

  try {
    const existing = await User.findOne({ phone: fullPhone });
    if (existing) {
      return res.status(409).send({ message: "User already exists" });
    }

    const user = await new User({ phone: fullPhone, name, email }).save();

    try {
      await Enquiry.findOneAndUpdate(
        { phone: fullPhone },
        { $set: { verified: true, name, email } }
      );
    } catch (e) {
      console.log("Enquiry update failed:", e.message);
    }

    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, jwtConfig);
    return res
      .status(200)
      .send({ token, message: "Account created successfully" });
  } catch (err) {
    console.error("[SignupInternational] failed:", err?.message || err);
    return res
      .status(400)
      .send({ message: "Signup failed", error: err?.message || String(err) });
  }
};

module.exports = {
  SendInternationalOTP,
  VerifyInternationalOTP,
  SignupInternational,
};

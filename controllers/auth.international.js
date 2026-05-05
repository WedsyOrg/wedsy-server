const axios = require("axios");
const jwt = require("jsonwebtoken");
const jwtConfig = require("../config/jwt");
const OTP = require("../models/OTP");
const User = require("../models/User");

const SendInternationalOTP = async (req, res) => {
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

    let user = await User.findOne({ phone: fullPhone });
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
    } else {
      user = await new User({ name: "", phone: fullPhone }).save();
    }

    const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, jwtConfig);
    return res.status(200).send({ token, message: "success" });
  } catch (err) {
    console.error(
      "[VerifyInternationalOTP] failed:",
      err?.message || err
    );
    return res.status(400).send({ message: "Invalid or expired OTP" });
  }
};

module.exports = { SendInternationalOTP, VerifyInternationalOTP };

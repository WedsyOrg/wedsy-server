const axios = require("axios");
const OTP = require("../models/OTP");
const { sendWhatsApp } = require("./whatsapp");
const { normalisePhone, nationalFor, leadingDigits, defaultCountryCode } = require("./phone");

const SendOTP = (phone) => {
  return new Promise(async (resolve, reject) => {
    // resolve({
    //   ReferenceId: Array.from(
    //     { length: 8 },
    //     () =>
    //       "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
    //         Math.floor(Math.random() * 62)
    //       ]
    //   ).join(""),
    // });
    try {
      const otp = Math.floor(100000 + Math.random() * 900000);
      new OTP({ phone, otp })
        .save()
        .then(async (result) => {
          let ReferenceId = result._id;

          // BOTH legs used to be built by string-replacing "+91", which does
          // NOTHING to "+971501234567" — that string does not contain "+91".
          // The SMS leg therefore handed the gateway a value with a "+" in it,
          // and the WhatsApp leg produced the malformed "91+971501234567",
          // i.e. an OTP sent to a destination that cannot exist. Both are now
          // derived through the ONE normaliser.
          const waDestination = normalisePhone(phone, { context: "otp-whatsapp" });
          // Fast2SMS is India-only (see services/NotificationService.js), so the
          // SMS leg is attempted ONLY when a national number can be derived —
          // and a skip says so rather than failing mutely at the gateway.
          const national = nationalFor(phone, defaultCountryCode());
          if (!national) {
            console.log(
              `[otp] SMS SKIPPED — Fast2SMS delivers to ${defaultCountryCode()} numbers only; ` +
                `this number begins ${leadingDigits(phone) || "(unreadable)"}. WhatsApp still attempted.`
            );
          }

          const data = JSON.stringify({
            route: "dlt",
            sender_id: "WEDSYY",
            message: "178506",
            variables_values: `${otp}`,
            flash: 0,
            numbers: national || "",
          });

          const [smsResult, waResult] = await Promise.allSettled([
            national
              ? axios({
                  method: "post",
                  url: process.env.FAST2SMS_API_URL,
                  headers: {
                    authorization: process.env.FAST2SMS_API_KEY,
                    "Content-Type": "application/json",
                  },
                  data,
                })
              : Promise.resolve(null),
            waDestination
              ? sendWhatsApp(
                  waDestination,
                  "otp_verification",
                  [otp.toString()],
                  { sub_type: "url", index: 0, parameters: [{ type: "text", text: otp.toString() }] }
                )
              : Promise.resolve(null),
          ]);

          if (smsResult.status === "rejected") {
            console.log(
              "Fast2SMS failed:",
              smsResult.reason?.response?.data || smsResult.reason?.message
            );
          }
          if (waResult.status === "rejected") {
            console.log(
              "WhatsApp OTP failed:",
              waResult.reason?.response?.data || waResult.reason?.message
            );
          }

          if (
            smsResult.status === "fulfilled" ||
            waResult.status === "fulfilled"
          ) {
            resolve({ ReferenceId });
          } else {
            reject({ message: "error", error: smsResult.reason });
          }
        })
        .catch((error) => {
          reject({ message: "error", error });
        });
    } catch (error) {
      reject({ message: "error", error });
    }
  });
};

const VerifyOTP = (phone, ReferenceId, Otp) => {
  return new Promise(async (resolve, reject) => {
    // resolve({ Valid: true });
    OTP.findOneAndDelete({ phone, otp: Otp, _id: ReferenceId })
      .then((result) => {
        if (result) {
          resolve({ Valid: true });
        } else {
          resolve({ Valid: false });
        }
      })
      .catch((error) => {
        reject({ message: "error", error });
      });

    // const data = JSON.stringify({
    //   DestinationIdentity: phone,
    //   ReferenceId,
    //   Otp,
    // });
    // const path = `/v1/apps/${process.env.AWS_PINPOINT_PROJECT_ID}/verify-otp`;
    // const headers = await getAuthHeaders({ payload: data, path });
    // axios({
    //   method: "post",
    //   url: `https://${process.env.AWS_PINPOINT_ENDPOINT}${path}`,
    //   headers,
    //   data,
    // })
    //   .then(function (response) {
    //     resolve(response.data);
    //   })
    //   .catch(function (error) {
    //     console.log(error.response.data);
    //     reject(error.response.data);
    //   });
  });
};

module.exports = { SendOTP, VerifyOTP };

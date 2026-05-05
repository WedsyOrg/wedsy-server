const axios = require("axios");
const OTP = require("../models/OTP");

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

          const smsData = JSON.stringify({
            route: "dlt",
            sender_id: "WEDSYY",
            message: "178506",
            variables_values: `${otp}`,
            flash: 0,
            numbers: phone.replace("+91", ""),
          });

          const [smsResult, waResult] = await Promise.allSettled([
            axios({
              method: "post",
              url: process.env.FAST2SMS_API_URL,
              headers: {
                authorization: process.env.FAST2SMS_API_KEY,
                "Content-Type": "application/json",
              },
              data: smsData,
            }),
            axios({
              method: "post",
              url: process.env.AISENSY_API_URL,
              headers: { "Content-Type": "application/json" },
              data: {
                apiKey: process.env.AISENSY_API_KEY_V2,
                campaignName: "otp_verification",
                destination: phone,
                userName: "User",
                templateParams: [otp.toString()],
              },
            }),
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

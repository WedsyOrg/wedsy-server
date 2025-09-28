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
        .then((result) => {
          let ReferenceId = result._id;
          const data = JSON.stringify({
            route: "dlt",
            sender_id: "WEDSYY",
            message: "163317",
            variables_values: `${otp}`,
            flash: 0,
            numbers: phone.replace("+91", ""),
          });
          axios({
            method: "post",
            url: `${process.env.FAST2SMS_API_URL}`,
            headers: {
              authorization: process.env.FAST2SMS_API_KEY,
              "Content-Type": "application/json",
            },
            body: data,
            data,
          })
            .then(function (response) {
              resolve({ ...response.data, ReferenceId });
            })
            .catch(function (error) {
              console.log(error);
              reject({ message: "error", error });
            });
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

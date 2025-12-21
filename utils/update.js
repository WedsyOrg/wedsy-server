const axios = require("axios");

// Channels(array): SMS, Whatsapp
// Message: New Lead; New User, Event Finalized, Event Approved
// Message: Event Planner (to Client by admin, whatsapp)
const SendUpdate = ({ channels, message, parameters }) => {
  const { name, phone } = parameters;
  let data = "";
  if (message === "Event Planner") {
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: "event_update_3",
          destination: phone,
          userName: name,
          templateParams: [parameters?.link || "https://wedsy.in/event/"],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
  } else if (message === "New Lead") {
    // user_lead
    if (channels.includes("SMS") && phone.includes("+91")) {
      try {
        data = JSON.stringify({
          route: "dlt",
          sender_id: "XWEDSY",
          message: "163269",
          variables_values: `${name}`,
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
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: "user_lead",
          destination: phone,
          userName: name,
          templateParams: [name],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
  } else if (message === "New User") {
    // account_success
    if (channels.includes("SMS") && phone.includes("+91")) {
      try {
        data = JSON.stringify({
          route: "dlt",
          sender_id: "WEDSYY",
          message: "163273",
          variables_values: `${name}`,
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
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: "account_success",
          destination: phone,
          userName: name,
          templateParams: [name],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
  } else if (message === "Event Approved") {
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: "eventapproval_confim",
          destination: phone,
          userName: name,
          templateParams: [name],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
  } else if (message === "Booking Reminder") {
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName: "booking_remind",
          destination: phone,
          userName: name,
          templateParams: [name],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending SMS", error);
          });
      } catch (error) {
        console.log("Error while sending SMS", error);
      }
    }
  } else if (message === "Vendor Payment Reminder") {
    // Vendor personal-lead payment reminder (Whatsapp)
    if (channels.includes("Whatsapp")) {
      try {
        data = JSON.stringify({
          apiKey: process.env.AISENSY_API_KEY,
          campaignName:
            process.env.AISENSY_VENDOR_PAYMENT_REMINDER_CAMPAIGN ||
            "vendor_payment_reminder",
          destination: phone,
          userName: name,
          // Configure your template to accept these params (order can vary)
          templateParams: [
            parameters?.name || name || "",
            String(parameters?.total ?? ""),
            String(parameters?.received ?? ""),
            String(parameters?.due ?? ""),
          ],
        });
        axios({
          method: "post",
          url: `${process.env.AISENSY_API_URL}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: data,
          data,
        })
          .then(function (response) {})
          .catch(function (error) {
            console.log("Error while sending Whatsapp", error);
          });
      } catch (error) {
        console.log("Error while sending Whatsapp", error);
      }
    }
  }
};

module.exports = { SendUpdate };

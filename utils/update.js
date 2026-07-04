const { send } = require("../services/NotificationService");

// Channels param is kept for backward compatibility but is no longer used —
// active channels are now controlled by the TRIGGERS config in NotificationService.
const SendUpdate = ({ channels, message, parameters }) => {
  const { name, phone } = parameters;

  if (message === "Event Planner") {
    const link =
      parameters?.link ||
      `${process.env.USER_APP_ORIGIN || "https://www.wedsy.in"}/event/`;
    send("event_link", { phone, name, variables: [link] });
  } else if (message === "New Lead") {
    // DISABLED: the external new_lead ping (Fast2SMS DLT template 163269 +
    // AiSensy "user_lead" campaign) is misconfigured against the providers and
    // 400s on every lead (the WhatsApp leg via AiSensy especially). New-lead
    // alerting now happens INTERNALLY via AdminNotificationService from
    // LeadIntakeService.afterCreate. Call sites are intentionally left intact;
    // this branch is a no-op so no other trigger is touched.
  } else if (message === "New User") {
    send("user_signup_greet", { phone, name, variables: [name] });
  } else if (message === "Event Approved") {
    send("event_approved", { phone, name, variables: [name] });
  } else if (message === "Booking Reminder") {
    send("cust_booking_rmnd", { phone, name, variables: [name] });
  } else if (message === "Vendor Payment Reminder") {
    send("mua_cx_pmnt_rmnd_prsnl", {
      phone,
      name,
      variables: [
        parameters?.name || name || "",
        String(parameters?.total ?? ""),
        String(parameters?.received ?? ""),
        String(parameters?.due ?? ""),
      ],
    });
  }
};

module.exports = { SendUpdate };

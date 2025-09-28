const Enquiry = require("../models/Enquiry");
const { SendUpdate } = require("../utils/update");

const CreateNewAdsLead = (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Enquiry({
      name,
      phone,
      email,
      verified: false,
      source: "Ads (Landing Screen)",
      additionalInfo: {},
    })
      .save()
      .then((result) => {
        SendUpdate({
          channels: ["SMS", "Whatsapp"],
          message: "New Lead",
          parameters: { name, phone },
        });
        res.status(201).send();
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

module.exports = { CreateNewAdsLead };

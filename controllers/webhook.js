const Enquiry = require("../models/Enquiry");
const { SendUpdate } = require("../utils/update");
const LeadIntakeService = require("../services/LeadIntakeService");

const CreateNewAdsLead = async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).send({ message: "Incomplete Data" });
    }
    // Lifecycle intake hook (additive): dedup-merge before insert. A re-enquiry
    // from ads does NOT create a duplicate — it stamps the existing lead and
    // appends a re_enquired event. Response contract preserved (201 empty).
    const existing = await LeadIntakeService.findExistingByNormalizedPhone(phone);
    if (existing) {
      await LeadIntakeService.recordReEnquiry(existing._id, {
        source: "Ads (Landing Screen)",
        message: "",
      });
      return res.status(201).send();
    }
    const result = await new Enquiry({
      name,
      phone,
      email,
      verified: false,
      source: "Ads (Landing Screen)",
      additionalInfo: {},
    }).save();
    // Lifecycle intake hook (additive): auto-assign the new lead.
    LeadIntakeService.afterCreate(result._id);
    SendUpdate({
      channels: ["SMS", "Whatsapp"],
      message: "New Lead",
      parameters: { name, phone },
    });
    return res.status(201).send();
  } catch (error) {
    return res.status(400).send({ message: "error", error });
  }
};

module.exports = { CreateNewAdsLead };

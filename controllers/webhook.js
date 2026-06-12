const Enquiry = require("../models/Enquiry");
const { SendUpdate } = require("../utils/update");
const LeadIntakeService = require("../services/LeadIntakeService");
const AdFormService = require("../services/AdFormService");

const CreateNewAdsLead = async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).send({ message: "Incomplete Data" });
    }
    // Ad-form capture (Settings Suite, Slice 4): every extra payload field is an
    // answer — stored raw, size-guarded, never dropped. The adform.fieldMap
    // setting additionally maps answers into qualificationData/customFields,
    // never overwriting non-empty values. Contract preserved: 201 empty.
    const answers = AdFormService.extractAnswers(req.body);

    const existing = await LeadIntakeService.findExistingByNormalizedPhone(phone);
    if (existing) {
      if (answers) {
        // Merge NEW answer keys into the lead (existing answers win) + apply mapping
        // into still-empty fields only.
        const mergeSets = {};
        const existingAnswers = existing.additionalInfo?.adFormAnswers || {};
        for (const [k, v] of Object.entries(answers)) {
          if (!(k in existingAnswers)) mergeSets[`additionalInfo.adFormAnswers.${k}`] = v;
        }
        const { sets } = await AdFormService.mappedSetsFor(answers, existing);
        Object.assign(mergeSets, sets);
        if (Object.keys(mergeSets).length) {
          await Enquiry.findByIdAndUpdate(existing._id, { $set: mergeSets });
        }
      }
      await LeadIntakeService.recordReEnquiry(existing._id, {
        source: "Ads (Landing Screen)",
        message: "",
        adFormAnswers: answers || undefined,
      });
      return res.status(201).send();
    }

    const { sets } = await AdFormService.mappedSetsFor(answers, null);
    const doc = {
      name,
      phone,
      email,
      verified: false,
      source: "Ads (Landing Screen)",
      additionalInfo: answers ? { adFormAnswers: answers } : {},
    };
    const result = await new Enquiry(doc).save();
    if (Object.keys(sets).length) {
      await Enquiry.findByIdAndUpdate(result._id, { $set: sets });
    }
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

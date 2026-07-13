// Journey v2 (V1) — the canonical lead brief endpoints.
const LeadBriefService = require("../services/LeadBriefService");
const AIBriefService = require("../services/AIBriefService");
const EnquiryRepository = require("../repositories/EnquiryRepository");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadBrief]", error);
  res.status(status).json({
    message: status === 500 ? "Something went wrong with the lead brief — please retry." : error.message,
  });
};

// PUT /enquiry/:_id/lead-brief { text } — owner/manager (route-gated).
const Save = async (req, res) => {
  try {
    const result = await LeadBriefService.saveBrief(
      req.params._id,
      req.body && req.body.text,
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/lead-brief/ai — returns { text } for HUMAN review.
// Deliberately never writes anything.
const AiSuggest = async (req, res) => {
  try {
    const lead = await EnquiryRepository.findById(req.params._id);
    if (!lead) return res.status(404).json({ message: "Enquiry not found" });
    const notes = await LeadBriefService.qualifierNoteFeed(req.params._id);
    const result = await AIBriefService.summariseBrief(lead, notes);
    res.status(200).json(result); // { text } — review-then-save, NEVER auto-saved
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Save, AiSuggest };

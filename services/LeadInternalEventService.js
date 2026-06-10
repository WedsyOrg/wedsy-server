const LeadInternalEventRepository = require("../repositories/LeadInternalEventRepository");

// Fire-and-safe (same contract as ActivityLogService): recording an internal
// event must NEVER break the primary action.
const record = async ({ leadId, type, actorId, payload }) => {
  try {
    return await LeadInternalEventRepository.create({ leadId, type, actorId, payload });
  } catch (e) {
    console.error("LeadInternalEvent.record failed:", e.message);
    return null;
  }
};

const listForLead = async (leadId, opts) =>
  LeadInternalEventRepository.findByLeadId(leadId, opts);

module.exports = { record, listForLead };

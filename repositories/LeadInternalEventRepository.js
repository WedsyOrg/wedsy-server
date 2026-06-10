const LeadInternalEvent = require("../models/LeadInternalEvent");

// Append one event row. No update/delete helpers — the stream is append-only by design.
const create = async ({ leadId, type, actorId, payload }) => {
  return await LeadInternalEvent.create({
    leadId,
    type,
    actorId: actorId || null,
    payload: payload || {},
  });
};

// Newest-first event stream for one lead.
const findByLeadId = async (leadId, { limit = 100 } = {}) => {
  return await LeadInternalEvent.find({ leadId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

module.exports = {
  create,
  findByLeadId,
};

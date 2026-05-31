const ActivityLogRepository = require("../repositories/ActivityLogRepository");
// Fire-and-safe: logging must NEVER break the primary action. Always wrapped in try/catch by caller, but also guard here.
const record = async ({ actorId, action, entityType = "stage", entityId, summary, meta }) => {
  try {
    return await ActivityLogRepository.create({ actorId: actorId || null, action, entityType, entityId: entityId != null ? String(entityId) : null, summary: summary || "", meta: meta || {} });
  } catch (e) {
    // Never throw from logging — return null so the primary action still succeeds.
    console.error("ActivityLog.record failed:", e.message);
    return null;
  }
};
const getRecent = async (opts) => ActivityLogRepository.findRecent(opts);
module.exports = { record, getRecent };

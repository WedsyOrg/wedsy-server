const ActivityLog = require("../models/ActivityLog");
// Register Admin so populate("actorId") works in standalone-script context too.
require("../models/Admin");
const create = async (doc) => ActivityLog.create(doc);
const findRecent = async ({ limit = 50, skip = 0, entityType } = {}) => {
  const q = {};
  if (entityType) q.entityType = entityType;
  const [items, total] = await Promise.all([
    ActivityLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("actorId", "name email").lean(),
    ActivityLog.countDocuments(q),
  ]);
  return { items, total };
};
module.exports = { create, findRecent };

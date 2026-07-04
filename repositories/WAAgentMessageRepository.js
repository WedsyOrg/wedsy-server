const WAAgentMessage = require('../models/WAAgentMessage');

// `extra` (additive, optional) carries the media* fields for inbound media rows;
// existing 3-arg callers pass nothing and behave exactly as before.
const saveMessage = async (phone, role, message, extra = {}) => {
  return await new WAAgentMessage({ phone, role, message, ...extra }).save();
};

const getHistory = async (phone, limit = 30) => {
  const messages = await WAAgentMessage
    .find({ phone })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return messages
    .reverse()
    .map(m => ({ role: m.role, content: m.message }));
};

module.exports = { saveMessage, getHistory };

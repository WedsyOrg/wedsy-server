const WAAgentMessage = require('../models/WAAgentMessage');

const saveMessage = async (phone, role, message) => {
  return await new WAAgentMessage({ phone, role, message }).save();
};

const getHistory = async (phone, limit = 30) => {
  const messages = await WAAgentMessage
    .find({ phone })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  return messages.map(m => ({ role: m.role, content: m.message }));
};

module.exports = { saveMessage, getHistory };

const WAConversation = require("../models/WAConversation");

const findByPhone = async (phone) => WAConversation.findOne({ phone });

const findById = async (id) => WAConversation.findById(id);

// Inbound message touch: create the conversation on first contact, bump the
// freshness fields and the unread counter on every one after. Atomic upsert —
// concurrent webhook deliveries can't double-create.
const upsertOnInbound = async (phone, normalizedPhone, preview, at = new Date()) =>
  WAConversation.findOneAndUpdate(
    { phone },
    {
      $set: {
        normalizedPhone,
        lastInboundAt: at,
        lastMessageAt: at,
        lastMessagePreview: preview,
      },
      $inc: { unreadCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

// Outbound (Kiara or human) touch: freshness + preview, unread untouched.
const touchOutbound = async (id, preview, at = new Date()) =>
  WAConversation.findByIdAndUpdate(
    id,
    { $set: { lastMessageAt: at, lastMessagePreview: preview } },
    { new: true }
  );

const updateFieldsById = async (id, fields) =>
  WAConversation.findByIdAndUpdate(id, { $set: fields }, { new: true });

// Inbox listing: needs-attention first, then by recency.
const list = async (filter = {}, { skip = 0, limit = 20 } = {}) =>
  WAConversation.find(filter)
    .sort({ needsHuman: -1, lastMessageAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

const count = async (filter = {}) => WAConversation.countDocuments(filter);

// Mission-quiet support: enquiry ids whose conversation is actively handled by
// Kiara (mode ai, open, not escalated) — these leads stay off call-now pressure.
const findQuietEnquiryIds = async () =>
  WAConversation.distinct("enquiryId", {
    mode: "ai",
    status: "active",
    needsHuman: false,
    enquiryId: { $ne: null },
  });

// Escalated conversations (for the dashboard mission card).
const findNeedsHuman = async () =>
  WAConversation.find({ needsHuman: true, status: "active" }).lean();

module.exports = {
  findByPhone,
  findById,
  upsertOnInbound,
  touchOutbound,
  updateFieldsById,
  list,
  count,
  findQuietEnquiryIds,
  findNeedsHuman,
};

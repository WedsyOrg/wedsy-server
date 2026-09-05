const WAConversation = require("../models/WAConversation");

const findByPhone = async (phone) => WAConversation.findOne({ phone });

const findById = async (id) => WAConversation.findById(id);

// Inbound message touch: create the conversation on first contact, bump the
// freshness fields and the unread counter on every one after. Atomic upsert —
// concurrent webhook deliveries can't double-create.
//
// ── A CUSTOMER COMING BACK REOPENS A CLOSED THREAD ──────────────────────────
// Kiara closes threads she classifies vendor / birthday / corporate. Until this,
// nothing ever reopened one: the customer could message again and the thread
// stayed closed, invisible to every human (all UI call sites ask for
// status:"active") AND unanswered by Kiara (both agents return early on
// status === "closed"). Production: 27 threads holding 154 unread messages.
//
// WHY THE REOPEN BELONGS HERE, of all places. Reaching this function already
// MEANS "a genuine customer inbound", structurally rather than by convention:
// its only caller is WAConversationService.recordInbound, which is reached only
// from the four inbound webhook paths, each persisting role:"user". Our own
// sends go through touchOutbound below and never come here; Instagram echoes are
// dropped at the webhook (is_echo) and WhatsApp delivery receipts arrive under
// value.statuses, which the controller never reads. So no "is this really from
// the customer?" check is needed — and adding one would imply doubt about an
// invariant the rest of this file already relies on.
//
// It is a SEPARATE guarded update, not part of the upsert below, for two
// reasons: reopenedAt must stamp ONLY on the closed→active transition (setting
// it on every inbound would make it a duplicate of lastInboundAt and destroy its
// meaning), and the upsert must keep setDefaultsOnInsert, which an aggregation-
// pipeline update would silently drop — creating conversations with no mode and
// no status.
const reopenIfClosed = async (phone, at = new Date()) =>
  WAConversation.findOneAndUpdate(
    { phone, status: "closed" },
    { $set: { status: "active", reopenedAt: at } },
    { new: true }
  );

const upsertOnInbound = async (phone, normalizedPhone, preview, at = new Date(), channel = "whatsapp") => {
  await reopenIfClosed(phone, at);
  return WAConversation.findOneAndUpdate(
    { phone },
    {
      $set: {
        normalizedPhone,
        lastInboundAt: at,
        lastMessageAt: at,
        lastMessagePreview: preview,
      },
      // Channel is identity, not state — written once at creation.
      $setOnInsert: { channel },
      $inc: { unreadCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Outbound (Kiara or human) touch: freshness + preview, unread untouched.
// Deliberately does NOT reopen: a thread closed on purpose must not come back
// because we sent something.
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
  reopenIfClosed,
  touchOutbound,
  updateFieldsById,
  list,
  count,
  findQuietEnquiryIds,
  findNeedsHuman,
};

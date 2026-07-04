const AdminNotification = require("../models/AdminNotification");

// Fire-and-safe like LeadInternalEventService — a failed notification must
// never break the action that triggered it.
const notify = async (adminIds, { type, title, message = "", leadId = null, payload = {} }) => {
  try {
    const ids = (Array.isArray(adminIds) ? adminIds : [adminIds]).filter(Boolean);
    if (!ids.length) return [];
    return await AdminNotification.insertMany(
      ids.map((adminId) => ({ adminId, type, title, message, leadId, payload }))
    );
  } catch (e) {
    console.error("AdminNotificationService.notify failed:", e.message);
    return [];
  }
};

const listMine = async (adminId, { unreadOnly = false, limit = 50 } = {}) => {
  const filter = { adminId };
  if (unreadOnly) filter.read = false;
  return await AdminNotification.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(100, limit))
    .lean();
};

const markRead = async (adminId, notificationId) =>
  await AdminNotification.findOneAndUpdate(
    { _id: notificationId, adminId },
    { $set: { read: true } },
    { new: true }
  );

const markAllRead = async (adminId) =>
  await AdminNotification.updateMany({ adminId, read: false }, { $set: { read: true } });

const unreadCount = async (adminId) =>
  await AdminNotification.countDocuments({ adminId, read: false });

module.exports = { notify, listMine, markRead, markAllRead, unreadCount };

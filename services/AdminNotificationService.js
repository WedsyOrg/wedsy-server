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

// Dedupe variant of notify(): at most ONE unread row per (adminId, type, leadId).
// A repeat while the first is still unread REFRESHES it (title/message/payload)
// instead of stacking a new row — ten chat messages in thirty seconds collapse
// into one entry. Single recipient by design; notify() above is untouched and
// keeps its fan-out. Fire-and-safe on the same terms: a failure never reaches
// the caller.
//
// The re-sort signal is `updatedAt`, which { timestamps: true } bumps on this
// findOneAndUpdate automatically. Do NOT try to force createdAt here: Mongoose
// strips a manual $set on a managed timestamp, so the row would silently never
// rise. listMine() sorts on updatedAt to match.
const notifyOnce = async (adminId, { type, title, message = "", leadId = null, payload = {} }) => {
  try {
    // leadId is half the dedupe key — without it there is nothing to collapse on.
    if (!adminId || !leadId) return null;
    const refreshed = await AdminNotification.findOneAndUpdate(
      { adminId, type, leadId, read: false },
      { $set: { title, message, payload } },
      { new: true }
    );
    if (refreshed) return refreshed;
    return await AdminNotification.create({ adminId, type, title, message, leadId, payload });
  } catch (e) {
    console.error("AdminNotificationService.notifyOnce failed:", e.message);
    return null;
  }
};

const listMine = async (adminId, { unreadOnly = false, limit = 50 } = {}) => {
  const filter = { adminId };
  if (unreadOnly) filter.read = false;
  return await AdminNotification.find(filter)
    // Bell order = most-recently-touched. updatedAt (not createdAt) so a row
    // refreshed by notifyOnce rises back to the top instead of sitting stale.
    .sort({ updatedAt: -1 })
    .limit(Math.min(100, limit))
    .lean();
};

// Retire a recipient's UNREAD rows of one type for one lead. Used when a fact
// stops being true for them — e.g. a lead moves off its previous owner, whose
// "assigned to you" row is now stale. Marks read (never deletes) so the trail
// survives. Fire-and-safe like the rest of this service.
const clearUnread = async (adminId, { type, leadId } = {}) => {
  try {
    if (!adminId || !type || !leadId) return 0;
    const res = await AdminNotification.updateMany(
      { adminId, type, leadId, read: false },
      { $set: { read: true } }
    );
    return res.modifiedCount || 0;
  } catch (e) {
    console.error("AdminNotificationService.clearUnread failed:", e.message);
    return 0;
  }
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

module.exports = { notify, notifyOnce, clearUnread, listMine, markRead, markAllRead, unreadCount };

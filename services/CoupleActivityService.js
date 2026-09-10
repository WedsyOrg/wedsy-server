/* THE ACTIVITY FEED (§ 06.3) — "every team action and every partner action
 * appends an Activity. Home's 'While you were away' is a query on it, filtered
 * by !readBy.includes(me)."
 *
 * It reuses models/ActivityLog — the audit trail this repo already has, with its
 * indexes and its 400-day retention — rather than opening a second feed
 * collection. Two things had to be mapped onto it:
 *
 *   entityType "wedding" + entityId = String(weddingId)
 *       is the wedding scope, and it rides the existing
 *       { entityType, createdAt } index.
 *
 *   actorId is `ref: "Admin"` on that model, so it holds an ADMIN id only —
 *       a Wedsy team member. A partner, a shared family member or a guest is
 *       NOT an Admin, and writing their User id into an Admin ref would be a
 *       populate that silently resolves to nothing. Their identity goes in
 *       meta.actor instead. `meta.actorType` says which kind of actor it was,
 *       which is exactly what the client renders.
 *
 * The builders are PURE; record() is the one function that writes.
 */

const ActivityLogService = require("./ActivityLogService");

const ACTOR_TYPES = ["couple", "team", "guest", "system"];

/**
 * Build the ActivityLog document for one couple-app action. Pure.
 *
 * @param {string} weddingId
 * @param {"couple"|"team"|"guest"|"system"} actorType
 * @param {object} actor  { id, name, avatar, adminId }
 */
const buildLog = ({
  weddingId,
  actorType = "system",
  actor = {},
  action,
  objectType = "",
  objectId = null,
  summary = "",
  meta = {},
}) => ({
  // Only a real Admin id belongs in this field — see the header.
  actorId: actorType === "team" && actor.adminId ? actor.adminId : null,
  action,
  entityType: "wedding",
  entityId: weddingId ? String(weddingId) : null,
  summary,
  meta: {
    ...meta,
    weddingId: weddingId ? String(weddingId) : null,
    actorType: ACTOR_TYPES.indexOf(actorType) === -1 ? "system" : actorType,
    actor: {
      id: actor.id ? String(actor.id) : null,
      name: actor.name || "",
      avatar: actor.avatar || "",
    },
    objectType,
    objectId: objectId ? String(objectId) : null,
    // Who has seen it. Home's digest is `!readBy.includes(me)`.
    readBy: [],
  },
});

/**
 * Append an activity. Never throws — ActivityLogService swallows its own
 * failures on purpose, because a feed row that could not be written must not
 * fail the guest's RSVP or the couple's payment.
 */
const record = async (input) => ActivityLogService.record(buildLog(input));

/**
 * Shape stored logs into what Home renders. Pure.
 *
 * The client's item is
 *   { id, actorId, actorName, actorAvatar, actorType, summary, createdAt, unread }
 *
 * @param {object[]} logs     ActivityLog documents (plain), newest first
 * @param {string}   viewerId the User._id reading the feed
 * @param {number}   [limit]  § 03.1 — "most recent 4"
 */
const toDigest = (logs, viewerId, limit = 4) => {
  const rows = Array.isArray(logs) ? logs : [];
  const me = viewerId ? String(viewerId) : "";
  return rows.slice(0, limit).map((log) => {
    const meta = (log && log.meta) || {};
    const actor = meta.actor || {};
    const readBy = Array.isArray(meta.readBy) ? meta.readBy.map(String) : [];
    return {
      id: String(log._id || ""),
      actorId: actor.id || (log.actorId ? String(log.actorId) : null),
      actorName: actor.name || "",
      actorAvatar: actor.avatar || "",
      actorType: meta.actorType || "system",
      summary: log.summary || "",
      createdAt: log.createdAt || null,
      unread: !me || readBy.indexOf(me) === -1,
    };
  });
};

/** How many of these has this person not seen? Drives the bell's dot. */
const unreadCount = (logs, viewerId) =>
  toDigest(logs, viewerId, Number.MAX_SAFE_INTEGER).filter((item) => item.unread).length;

module.exports = { buildLog, record, toDigest, unreadCount, ACTOR_TYPES };

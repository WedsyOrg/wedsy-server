const Attendance = require("../models/Attendance");
const Admin = require("../models/Admin");
const { assignableFilter } = require("../utils/assignable");

// Idle = no heartbeat for > 5 minutes while checked in. The frontend pings
// every 60s from an active tab, so a 5-min gap means the OS genuinely wasn't
// being used (tab hidden/closed/asleep).
const IDLE_GAP_MS = 5 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// IST calendar day — attendance is an India-office concept.
const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// Derived per-employee status. in_meeting comes from the calendar layer
// (Slice 3) via the liveMeetingIds set so this service stays dependency-free.
const statusOf = (row, now = new Date(), liveMeetingIds = new Set()) => {
  if (!row || !row.checkInAt || row.checkOutAt) return "checked_out";
  if (liveMeetingIds.has(String(row.adminId))) return "in_meeting";
  const last = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : 0;
  return now.getTime() - last > IDLE_GAP_MS ? "idle" : "online";
};

// Check in (idempotent). Re-check-in after a check-out re-opens the same day:
// checkInAt keeps the FIRST stamp, the away time becomes an idle segment.
const checkIn = async (adminId, now = new Date()) => {
  const date = dayKey(now);
  let row = await Attendance.findOne({ adminId, date });
  if (!row) {
    try {
      row = await Attendance.create({ adminId, date, checkInAt: now, lastHeartbeatAt: now });
    } catch (e) {
      // double-click race on the unique index
      row = await Attendance.findOne({ adminId, date });
      if (!row) throw e;
    }
    return row;
  }
  if (row.checkOutAt) {
    row.idleSegments.push({ from: row.checkOutAt, to: now });
    row.idleMs += now.getTime() - new Date(row.checkOutAt).getTime();
    row.checkOutAt = null;
    row.lastHeartbeatAt = now;
    await row.save();
  }
  return row;
};

const checkOut = async (adminId, now = new Date()) => {
  const date = dayKey(now);
  const row = await Attendance.findOne({ adminId, date });
  if (!row || row.checkOutAt) throw httpError(409, "Not checked in");
  // A silent gap right before checkout is idle time too.
  const last = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt) : row.checkInAt;
  if (now.getTime() - last.getTime() > IDLE_GAP_MS) {
    row.idleSegments.push({ from: last, to: now });
    row.idleMs += now.getTime() - last.getTime();
  }
  row.checkOutAt = now;
  await row.save();
  return row;
};

// Activity ping (60s cadence while the tab is visible). A gap > 5 min closes
// as an idle segment. No-op when not checked in (404 keeps the client honest).
const heartbeat = async (adminId, now = new Date()) => {
  const date = dayKey(now);
  const row = await Attendance.findOne({ adminId, date });
  if (!row || row.checkOutAt) throw httpError(404, "Not checked in");
  const last = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt) : row.checkInAt;
  const gap = now.getTime() - last.getTime();
  if (gap > IDLE_GAP_MS) {
    row.idleSegments.push({ from: last, to: now });
    row.idleMs += gap;
  }
  row.lastHeartbeatAt = now;
  await row.save();
  return row;
};

// Own status — the transparency view: the employee sees exactly what the
// system recorded about them (status + today's idle total).
const me = async (adminId, liveMeetingIds = new Set()) => {
  const now = new Date();
  const row = await Attendance.findOne({ adminId, date: dayKey(now) }).lean();
  return {
    date: dayKey(now),
    status: statusOf(row, now, liveMeetingIds),
    checkInAt: row ? row.checkInAt : null,
    checkOutAt: row ? row.checkOutAt : null,
    idleMs: row ? row.idleMs : 0,
    lastHeartbeatAt: row ? row.lastHeartbeatAt : null,
  };
};

// Admin ids visible under a lead-scope filter built with ownerField "adminId":
// {} (all) → every active admin; {adminId: X} → [X]; {adminId:{$in:[..]}} → those.
const visibleAdminIds = async (scopeFilter = {}) => {
  if (!scopeFilter || Object.keys(scopeFilter).length === 0) {
    const all = await Admin.find(assignableFilter(), { _id: 1 }).lean();
    return all.map((a) => a._id);
  }
  const v = scopeFilter.adminId;
  if (v && v.$in) return v.$in;
  return v ? [v] : [];
};

// Daily team list: one row per visible admin with status + day numbers.
// liveMeetingIds injected by the controller (calendar layer, Slice 3).
const team = async ({ date } = {}, scopeFilter = {}, liveMeetingIds = new Set()) => {
  const day = date || dayKey();
  const ids = await visibleAdminIds(scopeFilter);
  const [admins, rows] = await Promise.all([
    Admin.find(assignableFilter({ _id: { $in: ids } }), { name: 1, email: 1 }).lean(),
    Attendance.find({ adminId: { $in: ids }, date: day }).lean(),
  ]);
  const byAdmin = new Map(rows.map((r) => [String(r.adminId), r]));
  const now = new Date();
  const isToday = day === dayKey(now);
  return {
    date: day,
    list: admins
      .map((a) => {
        const row = byAdmin.get(String(a._id)) || null;
        return {
          adminId: a._id,
          name: a.name,
          // Past days have no "live" status — everyone reads checked_out unless absent entirely.
          status: isToday ? statusOf(row, now, liveMeetingIds) : row ? "checked_out" : "absent",
          present: !!row,
          checkInAt: row ? row.checkInAt : null,
          checkOutAt: row ? row.checkOutAt : null,
          idleMs: row ? row.idleMs : 0,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name)),
  };
};

module.exports = {
  IDLE_GAP_MS,
  dayKey,
  statusOf,
  checkIn,
  checkOut,
  heartbeat,
  me,
  team,
  visibleAdminIds,
};

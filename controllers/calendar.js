const CalendarEventService = require("../services/CalendarEventService");
const AdminNotificationService = require("../services/AdminNotificationService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

const Team = async (req, res) => {
  try {
    res.status(200).json(
      await CalendarEventService.teamCalendar(
        { from: req.query.from, to: req.query.to },
        req.scopeFilter || {}
      )
    );
  } catch (error) {
    respond(res, error);
  }
};

const Create = async (req, res) => {
  try {
    res.status(201).json(await CalendarEventService.createEvent(req.auth.user_id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const SaveNotes = async (req, res) => {
  try {
    res
      .status(200)
      .json(await CalendarEventService.saveNotes(req.params.id, req.auth.user_id, (req.body || {}).notes));
  } catch (error) {
    respond(res, error);
  }
};

const Close = async (req, res) => {
  try {
    res.status(200).json(await CalendarEventService.closeMeeting(req.params.id, req.auth.user_id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const MeetingMode = async (req, res) => {
  try {
    res.status(200).json(await CalendarEventService.meetingMode(req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

const Unclosed = async (req, res) => {
  try {
    res.status(200).json({ list: await CalendarEventService.unclosedList(req.scopeFilter || {}) });
  } catch (error) {
    respond(res, error);
  }
};

const CompleteHuddle = async (req, res) => {
  try {
    res
      .status(200)
      .json(await CalendarEventService.completeHuddle(req.params.id, req.auth.user_id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const LeadEvents = async (req, res) => {
  try {
    res.status(200).json(await CalendarEventService.leadEvents(req.params.leadId));
  } catch (error) {
    respond(res, error);
  }
};

// ── Admin notifications (in-OS dashboard entries) ─────────────────────────────

const MyNotifications = async (req, res) => {
  try {
    const list = await AdminNotificationService.listMine(req.auth.user_id, {
      unreadOnly: req.query.unread === "true",
      limit: parseInt(req.query.limit, 10) || 50,
    });
    const unread = await AdminNotificationService.unreadCount(req.auth.user_id);
    res.status(200).json({ list, unread });
  } catch (error) {
    respond(res, error);
  }
};

const MarkRead = async (req, res) => {
  try {
    const updated = await AdminNotificationService.markRead(req.auth.user_id, req.params.id);
    if (!updated) return res.status(404).json({ message: "Notification not found" });
    res.status(200).json(updated);
  } catch (error) {
    respond(res, error);
  }
};

const MarkAllRead = async (req, res) => {
  try {
    await AdminNotificationService.markAllRead(req.auth.user_id);
    res.status(200).json({ ok: true });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = {
  Team,
  Create,
  SaveNotes,
  Close,
  MeetingMode,
  Unclosed,
  CompleteHuddle,
  LeadEvents,
  MyNotifications,
  MarkRead,
  MarkAllRead,
};

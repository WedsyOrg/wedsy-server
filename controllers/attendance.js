const AttendanceService = require("../services/AttendanceService");
const AttendanceDayService = require("../services/AttendanceDayService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

// Live-meeting set for in_meeting status. Lazy-required so the attendance
// brick has no hard dependency on the calendar brick (Slice 3 fills this in).
const liveMeetingIds = async () => {
  try {
    const CalendarEventService = require("../services/CalendarEventService");
    return await CalendarEventService.liveMeetingAdminIds();
  } catch (_) {
    return new Set();
  }
};

const CheckIn = async (req, res) => {
  try {
    await AttendanceService.checkIn(req.auth.user_id);
    res.status(200).json(await AttendanceService.me(req.auth.user_id, await liveMeetingIds()));
  } catch (error) {
    respond(res, error);
  }
};

const CheckOut = async (req, res) => {
  try {
    await AttendanceService.checkOut(req.auth.user_id);
    res.status(200).json(await AttendanceService.me(req.auth.user_id, await liveMeetingIds()));
  } catch (error) {
    respond(res, error);
  }
};

const Heartbeat = async (req, res) => {
  try {
    await AttendanceService.heartbeat(req.auth.user_id);
    res.status(200).json({ ok: true });
  } catch (error) {
    respond(res, error);
  }
};

// GET /attendance/me[?month=YYYY-MM]
// Without month: today, exactly as before. With it: today PLUS that month's
// rows. Login-gated only — the transparency rule covers a person's whole
// history, not just the day they happen to be looking at.
const Me = async (req, res) => {
  try {
    res
      .status(200)
      .json(await AttendanceService.me(req.auth.user_id, await liveMeetingIds(), { month: req.query.month }));
  } catch (error) {
    respond(res, error);
  }
};

// POST /attendance/:adminId/:date/resolve  { outcome, reason }
// A MANAGER resolving one of their team's system-closed days. Distinct from the
// founder's convert-on-the-run path: different actor, different gate, and it
// happens on the day rather than at month end.
const Resolve = async (req, res) => {
  try {
    const { adminId, date } = req.params;
    // The permission middleware resolved the caller's scope into a filter; a
    // target outside it is a 403, not an empty result. Checked BEFORE any write.
    const visible = await AttendanceService.visibleAdminIds(req.scopeFilter || {});
    if (!visible.some((id) => String(id) === String(adminId))) {
      return res.status(403).json({ message: "That person is outside your scope" });
    }
    const row = await AttendanceDayService.resolveDayByOutcome(
      { adminId, date, outcome: req.body && req.body.outcome, reason: req.body && req.body.reason },
      req.auth.user_id
    );
    res.status(200).json({ message: "resolved", day: row });
  } catch (error) {
    respond(res, error);
  }
};

// POST /attendance/me/:date/note  { text }
// The employee's own explanation of a day — including the fine on it. Login
// only, own row only: adminId comes from the token and is never read from the
// request, so a note cannot be written in someone else's name.
const Note = async (req, res) => {
  try {
    const day = await AttendanceService.setEmployeeNote(
      req.auth.user_id,
      req.params.date,
      req.body && req.body.text
    );
    res.status(200).json({ message: "noted", day });
  } catch (error) {
    respond(res, error);
  }
};

const Team = async (req, res) => {
  try {
    res
      .status(200)
      .json(
        await AttendanceService.team(
          { date: req.query.date },
          req.scopeFilter || {},
          await liveMeetingIds()
        )
      );
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { CheckIn, CheckOut, Heartbeat, Me, Team, Resolve, Note };

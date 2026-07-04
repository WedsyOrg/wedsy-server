const AttendanceService = require("../services/AttendanceService");

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

const Me = async (req, res) => {
  try {
    res.status(200).json(await AttendanceService.me(req.auth.user_id, await liveMeetingIds()));
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

module.exports = { CheckIn, CheckOut, Heartbeat, Me, Team };

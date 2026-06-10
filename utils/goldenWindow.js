// Golden window: a New lead created during work hours must get its first call
// within GOLDEN_WINDOW_MINUTES; out-of-hours leads are due by 10:30 IST the next
// working morning. Read-time only — no cron, no stored state.
// Configurable via Settings later — constants for Phase 1.
const GOLDEN_WINDOW_MINUTES = 30;
const WORK_START_HOUR = 10; // IST
const WORK_END_HOUR = 19; // IST
const OUT_OF_HOURS_DUE_MINUTE = 30; // due 10:30 IST next working morning

// IST is fixed UTC+5:30 (no DST) — shift and read UTC parts as IST wall clock.
const IST_OFFSET_MS = 330 * 60 * 1000;
const toIstWallClock = (d) => new Date(d.getTime() + IST_OFFSET_MS);
const fromIstParts = (y, mo, day, h, mi) =>
  new Date(Date.UTC(y, mo, day, h, mi) - IST_OFFSET_MS);

// Start of "today" in IST as a real Date (UTC instant).
const istDayStart = (now = new Date()) => {
  const ist = toIstWallClock(now);
  return fromIstParts(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0);
};
const istDayEnd = (now = new Date()) =>
  new Date(istDayStart(now).getTime() + 24 * 60 * 60 * 1000 - 1);

// First-call deadline for a lead created at `createdAt`.
const goldenDeadline = (createdAt) => {
  const created = new Date(createdAt);
  const ist = toIstWallClock(created);
  const hour = ist.getUTCHours();
  if (hour >= WORK_START_HOUR && hour < WORK_END_HOUR) {
    return new Date(created.getTime() + GOLDEN_WINDOW_MINUTES * 60 * 1000);
  }
  // Out of hours: due 10:30 IST the same morning (created 00:00–09:59)
  // or the next morning (created 19:00–23:59).
  const dayShift = hour < WORK_START_HOUR ? 0 : 1;
  return fromIstParts(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + dayShift,
    WORK_START_HOUR,
    OUT_OF_HOURS_DUE_MINUTE
  );
};

// { deadline, inWindow, minutesLeft, minutesOver } for an uncalled lead.
const goldenWindowFor = (createdAt, now = new Date()) => {
  const deadline = goldenDeadline(createdAt);
  const msLeft = deadline.getTime() - now.getTime();
  return {
    deadline,
    inWindow: msLeft > 0,
    minutesLeft: msLeft > 0 ? Math.ceil(msLeft / 60000) : 0,
    minutesOver: msLeft >= 0 ? 0 : Math.ceil(-msLeft / 60000),
  };
};

module.exports = {
  GOLDEN_WINDOW_MINUTES,
  WORK_START_HOUR,
  WORK_END_HOUR,
  goldenDeadline,
  goldenWindowFor,
  istDayStart,
  istDayEnd,
  toIstWallClock,
  fromIstParts,
};

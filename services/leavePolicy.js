const { istWeekday } = require("./hrPolicy");

// ── LEAVE POLICY — the rules, as pure functions ─────────────────────────────
// No DB here. Everything is (inputs) → (verdict) so each rule is testable on its
// own and the service below stays about orchestration.

const TYPES = ["CL", "SL", "EL", "WFH"];

// Full-year entitlement, calendar year Jan-Dec.
const ANNUAL = { CL: 12, SL: 8, EL: 12, WFH: 12 };

// ── THE 2026 STUB ───────────────────────────────────────────────────────────
// The system starts in August 2026; Mar-Jul is written off. Aug-Dec is 5 of 12
// months, pro-rated: CL 5, SL 3.5 (8 × 5/12 = 3.33, rounded up to the half-day
// granularity the module already supports), EL 5, WFH 5 (1/month falls out).
// Everyone gets the same regardless of joining date — the founder's ruling.
// Nothing carries OUT of it; 1 Jan 2027 resets to ANNUAL.
const STUB_YEAR = 2026;
const STUB_ENTITLEMENT = { CL: 5, SL: 3.5, EL: 5, WFH: 5 };

const entitlementFor = (type, year) =>
  year === STUB_YEAR ? STUB_ENTITLEMENT[type] : ANNUAL[type];

const isStubYear = (year) => year === STUB_YEAR;

// EL is the only carrying type, and the cap is on the CARRY, not the total —
// so 2027 can legitimately open at 12 + 20 = 32.
const EL_CARRY_CAP = 20;

const carryForward = (type, fromYear, unused) => {
  if (type !== "EL") return 0;
  // A stub is a write-off window, not year one. Nothing leaves it.
  if (isStubYear(fromYear)) return 0;
  return Math.max(0, Math.min(Number(unused) || 0, EL_CARRY_CAP));
};

// Minimum advance notice. WARN AND FLAG, never block.
const NOTICE_DAYS = { CL: 1, SL: 0, EL: 15, WFH: 1 };

const MAX_CONSECUTIVE = { CL: 2 };          // working days
const MEDICAL_CERT_OVER_DAYS = { SL: 2 };   // strictly MORE than 2 total days
const WFH_PER_MONTH = 1;
const COMP_OFF_VALID_DAYS = 30;

// ── day-key helpers (IST "YYYY-MM-DD" throughout) ───────────────────────────
const shiftDay = (day, delta) => {
  const [y, m, d] = String(day).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => {
  const [ay, am, ad] = String(a).split("-").map(Number);
  const [by, bm, bd] = String(b).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
};
const yearOf = (day) => Number(String(day).slice(0, 4));
const monthKey = (day) => String(day).slice(0, 7);

// A working day for leave purposes: in hr.workingDays and not a company holiday.
const isWorkingDay = (day, workingDays, holidayKeys) =>
  (workingDays || []).includes(istWeekday(day)) && !(holidayKeys || new Set()).has(day);

// ── CL: max 2 CONSECUTIVE WORKING days ──────────────────────────────────────
// Consecutive by WORKING day, so a Sunday or company holiday does NOT break the
// chain — otherwise Fri + Mon is a trivial route to a three-day CL.
// `existing` are the person's other pending/approved CL day keys, so two separate
// requests cannot defeat the cap either.
const consecutiveRunLength = (dayKeys, workingDays, holidayKeys) => {
  const set = new Set(dayKeys);
  let longest = 0;
  for (const day of set) {
    // Only start counting from the beginning of a run.
    let prev = shiftDay(day, -1);
    while (!isWorkingDay(prev, workingDays, holidayKeys)) prev = shiftDay(prev, -1);
    if (set.has(prev)) continue;
    let run = 0;
    let cur = day;
    while (set.has(cur)) {
      run += 1;
      let next = shiftDay(cur, 1);
      while (!isWorkingDay(next, workingDays, holidayKeys)) next = shiftDay(next, 1);
      cur = next;
    }
    if (run > longest) longest = run;
  }
  return longest;
};

// ── CL cannot be clubbed with EL ────────────────────────────────────────────
// No CL day may sit adjacent to an EL day across WORKING days, evaluated against
// ALL of the person's pending and approved leave — within-request-only would be
// decorative, since two requests would defeat it.
const clubsWithEl = (clDays, elDays, workingDays, holidayKeys) => {
  const el = new Set(elDays);
  for (const day of clDays) {
    if (el.has(day)) return day;
    let prev = shiftDay(day, -1);
    while (!isWorkingDay(prev, workingDays, holidayKeys)) prev = shiftDay(prev, -1);
    let next = shiftDay(day, 1);
    while (!isWorkingDay(next, workingDays, holidayKeys)) next = shiftDay(next, 1);
    if (el.has(prev) || el.has(next)) return day;
  }
  return null;
};

// Notice given, in days, from submission to the EARLIEST requested day.
const noticeFor = (todayKey, dayKeys) => {
  const earliest = [...dayKeys].sort()[0];
  return daysBetween(todayKey, earliest);
};

// Same-day rule: auto-reject when the earliest requested date is today or past.
// Starting tomorrow is fine.
const isSameDayOrPast = (todayKey, dayKeys) => noticeFor(todayKey, dayKeys) <= 0;

module.exports = {
  TYPES, ANNUAL, STUB_YEAR, STUB_ENTITLEMENT, EL_CARRY_CAP,
  NOTICE_DAYS, MAX_CONSECUTIVE, MEDICAL_CERT_OVER_DAYS, WFH_PER_MONTH, COMP_OFF_VALID_DAYS,
  entitlementFor, isStubYear, carryForward,
  shiftDay, daysBetween, yearOf, monthKey, isWorkingDay,
  consecutiveRunLength, clubsWithEl, noticeFor, isSameDayOrPast,
};

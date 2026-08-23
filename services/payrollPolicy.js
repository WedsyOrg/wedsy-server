const { istWeekday } = require("./hrPolicy");

// ── Payroll arithmetic — pure functions, no DB ──────────────────────────────

// ⚠️ A DAY'S PAY = monthly gross / 30. FIXED, every month, regardless of whether
// the month has 28 or 31 days.
//
// The earlier design used working days (Mon-Sat minus holidays), which is the
// more defensible theory — Rohaan pays for working days, so a lost day should
// cost a working day. It was changed deliberately: Razorpay's default salary
// structure computes Loss of Pay on the total days in the month, not working
// days, so a working-day basis here would make their payslip and this sheet
// disagree by 15-20% depending on the month (Nov 2026: ₹2,400 vs ₹2,000 on a
// ₹60k gross). Agreeing exactly with the system that actually pays people is
// worth more than the theory. Do not "fix" this back to working days without
// also changing Razorpay's salary structure.
const DAY_DIVISOR = 30;

const monthKeyOf = (dayKey) => String(dayKey).slice(0, 7);
const monthStart = (month) => `${month}-01`;
const daysInMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthEnd = (month) => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;

const eachDay = (month) => {
  const out = [];
  const n = daysInMonth(month);
  for (let d = 1; d <= n; d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
};

// Working days in the month — Mon-Sat minus company holidays. NOT used as the
// pay divisor (see above); reported on the sheet as context, and used to show
// how many days a person was actually expected in.
const workingDaysIn = (month, workingDays, holidayKeys) =>
  eachDay(month).filter(
    (d) => (workingDays || []).includes(istWeekday(d)) && !(holidayKeys || new Set()).has(d)
  );

const monthlyGross = (annualCtc) => (Number(annualCtc) || 0) / 12;
const dayRate = (gross) => (Number(gross) || 0) / DAY_DIVISOR;

// ── PRO-RATION uses the month's ACTUAL length, not the /30 divisor ───────────
// Two different questions, and one number cannot answer both. A full month must
// pay exactly the gross — with /30 a 31-day month would over-pay and February
// would under-pay. So proration is calendarDaysEmployed / daysInMonth, while a
// LOP day costs gross/30. Deliberate, not an inconsistency.
const prorateGross = (gross, month, { joinedDay, exitedDay }) => {
  const all = eachDay(month);
  const employed = all.filter(
    (d) => (!joinedDay || d >= joinedDay) && (!exitedDay || d <= exitedDay)
  );
  if (employed.length === all.length) return { gross: Number(gross) || 0, prorated: false, daysEmployed: all.length, daysInMonth: all.length };
  return {
    gross: ((Number(gross) || 0) * employed.length) / all.length,
    prorated: true,
    daysEmployed: employed.length,
    daysInMonth: all.length,
  };
};

// The salary in force for a month: the latest record effective on or before the
// 1st. A raise dated mid-October therefore lands in November's sheet.
const governingSalary = (records, month) => {
  const start = monthStart(month);
  const eligible = (records || [])
    .filter((r) => String(r.effectiveFrom) <= start)
    .sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
  return eligible.length ? eligible[eligible.length - 1] : null;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = {
  DAY_DIVISOR, monthKeyOf, monthStart, monthEnd, daysInMonth, eachDay,
  workingDaysIn, monthlyGross, dayRate, prorateGross, governingSalary, round2,
};

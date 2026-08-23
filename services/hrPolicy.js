const SettingsService = require("./SettingsService");

// ── HR attendance policy: resolve it, and judge a check-in against it ────────
//
// LATENESS IS MEASURED FROM THE START TIME, NOT FROM THE GRACE CUTOFF, and the
// bands are measured the same way. That is what makes the founder's policy fall
// out exactly:
//
//   start 11:00, grace 20  →  fine-free through 11:20
//   band { toMinutes: 60,   fine: 300 }  →  11:21-12:00
//   band { toMinutes: null, fine: 500 }  →  after 12:00
//
// If lateMinutes were measured from the 11:20 cutoff instead, toMinutes:60 would
// mean 12:20 and every fine boundary would be forty minutes wrong. Keep the two
// definitions aligned when editing either.

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (hhmm) => {
  const m = HHMM_RE.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

// IST wall-clock minutes past midnight for an instant.
const istMinutes = (d) => {
  const hhmm = new Date(d).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return minutesOf(hhmm);
};

// IST calendar day "YYYY-MM-DD" — the one key Attendance and CompanyHoliday share.
const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ISO weekday, 1 = Monday … 7 = Sunday, in IST.
const istWeekday = (dateStr) => {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
};

// The policy a PERSON is judged against. The only per-person lever is the start
// time (Admin.meta.workStartTime); grace and bands are company-wide. Returns the
// object that gets snapshotted onto the row, so it is deliberately plain data.
const effectivePolicyFor = async (admin) => {
  const s = await SettingsService.getMany([
    "hr.workStartTime",
    "hr.graceMinutes",
    "hr.lateBands",
    "hr.workingDays",
  ]);
  const override = admin && admin.meta && admin.meta.workStartTime;
  const usePerson = typeof override === "string" && HHMM_RE.test(override);
  return {
    workStartTime: usePerson ? override : s["hr.workStartTime"],
    graceMinutes: s["hr.graceMinutes"],
    lateBands: s["hr.lateBands"],
    workingDays: s["hr.workingDays"],
    source: usePerson ? "person" : "company",
  };
};

// Judge a check-in instant against a resolved policy.
//   lateMinutes — whole minutes past the START time (0 when on time or early)
//   fineAmount  — 0 within grace, else the first band whose toMinutes covers it
const judgeCheckIn = (checkInAt, policy) => {
  const start = minutesOf(policy.workStartTime);
  const at = istMinutes(checkInAt);
  if (start == null || at == null) return { lateMinutes: 0, fineAmount: 0 };

  const lateMinutes = Math.max(0, at - start);
  const grace = Number(policy.graceMinutes) || 0;
  if (lateMinutes <= grace) return { lateMinutes, fineAmount: 0 };

  const bands = Array.isArray(policy.lateBands) ? policy.lateBands : [];
  for (const band of bands) {
    if (band.toMinutes === null || lateMinutes <= Number(band.toMinutes)) {
      return { lateMinutes, fineAmount: Number(band.fine) || 0 };
    }
  }
  // No open-ended band configured — validation forbids this, but never invent a
  // fine from a malformed policy.
  return { lateMinutes, fineAmount: 0 };
};

// The snapshot stored on the row: enough to re-explain a disputed fine months
// later without depending on what the settings say by then.
const snapshotOf = (policy) => ({
  workStartTime: policy.workStartTime,
  graceMinutes: policy.graceMinutes,
  lateBands: policy.lateBands,
  source: policy.source,
});

const isWorkingDay = (dateStr, policy) =>
  (policy.workingDays || []).includes(istWeekday(dateStr));

module.exports = {
  HHMM_RE,
  minutesOf,
  istMinutes,
  istWeekday,
  dayKey,
  effectivePolicyFor,
  judgeCheckIn,
  snapshotOf,
  isWorkingDay,
};

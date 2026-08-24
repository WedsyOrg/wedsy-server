const Admin = require("../models/Admin");

// ─────────────────────────────────────────────────────────────────────────────
// "WAS THIS PERSON EMPLOYED ON THIS DATE?" — payroll's own predicate.
//
// ⚠️ DO NOT USE assignableFilter() FOR THIS. That answers a different question —
// "can this admin receive work" — and filters status:"active", which EXCLUDES
// status:"on_leave": exactly the people whose absence most needs explaining. It
// would also drop anyone disabled mid-month who is still owed the days they
// worked. The two predicates must stay separate.
//
// IT DEGRADES HONESTLY. On prod, 10 of 16 admins have no joinedAt. Rather than
// guessing a start date, an unknown window returns employed:true with
// certain:false and a reason — the sweep still records the day, and the sheet
// can show "start date not recorded" instead of quietly inventing one.
// ─────────────────────────────────────────────────────────────────────────────

// A login that is not a person: integrations, shared accounts, seed/test users.
// Set by a HUMAN on Admin.meta.isServiceAccount — nothing here infers it from a
// name, because "Wedsy Admin" is a guess and a wrong guess silently deletes
// someone from payroll.
const isServiceAccount = (admin) => !!(admin && admin.meta && admin.meta.isServiceAccount);

// Mongo filter for "people payroll cares about". Deliberately does NOT filter
// status — on_leave is still employed.
const employeeFilter = (extra = {}) => ({
  "meta.isServiceAccount": { $ne: true },
  ...extra,
});

const employedOn = (admin, dateStr) => {
  if (!admin) return { employed: false, certain: true, reason: "no such admin" };
  if (isServiceAccount(admin)) {
    return { employed: false, certain: true, reason: "service account, not a person" };
  }
  const day = String(dateStr);
  const joined = admin.joinedAt ? new Date(admin.joinedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : null;
  const exited = admin.meta && admin.meta.exitedAt
    ? new Date(admin.meta.exitedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    : null;

  if (joined && day < joined) {
    return { employed: false, certain: true, reason: `joined ${joined}` };
  }
  if (exited && day > exited) {
    return { employed: false, certain: true, reason: `exited ${exited}` };
  }
  // Marked as having left but with no date recorded. Same shape as the disabled
  // case: excluded going forward, flagged uncertain, and NEVER retroactive —
  // with no date there is nothing to compare a past month against, so a month
  // they worked would silently vanish if this returned a confident false.
  if (admin.status === "exited" && !exited) {
    return { employed: false, certain: false, reason: "marked exited, no exit date recorded" };
  }
  // Disabled with no recorded exit date: access is revoked, so they cannot check
  // in and cannot be "absent" from a job they cannot log into. Their existing
  // rows are untouched — days already worked are already recorded.
  if (admin.isDisabled && !exited) {
    return { employed: false, certain: false, reason: "access disabled, no exit date recorded" };
  }
  if (!joined) {
    return { employed: true, certain: false, reason: "joinedAt not recorded" };
  }
  return { employed: true, certain: true, reason: "" };
};

// Everyone payroll should materialise a day for, on one date.
const employedOnDate = async (dateStr, extra = {}) => {
  const admins = await Admin.find(employeeFilter(extra), {
    name: 1, email: 1, joinedAt: 1, isDisabled: 1, status: 1, meta: 1,
  }).lean();
  return admins
    .map((a) => ({ admin: a, ...employedOn(a, dateStr) }))
    .filter((r) => r.employed);
};

// Has this person left, as of today? A convenience over employedOn for the
// places that only care about "now" — leave routing, approver resolution — and
// deliberately NOT used by payroll, which always asks about a specific date.
const hasExited = (admin, todayKey) => {
  const r = employedOn(admin, todayKey || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  return !r.employed && /exited|marked exited/.test(r.reason);
};

// ── SUGGESTING service accounts, never assuming one ─────────────────────────
// Returns candidates for a HUMAN to confirm by setting meta.isServiceAccount.
// The signals are all absences of evidence — no join date, no designation, no
// employee id — deliberately NOT the name, so a real employee with a sparse
// profile shows up as a question rather than being silently excluded.
const listLikelyServiceAccounts = async () => {
  const admins = await Admin.find(
    { "meta.isServiceAccount": { $ne: true } },
    { name: 1, email: 1, joinedAt: 1, meta: 1, createdAt: 1 }
  ).lean();
  return admins
    .map((a) => {
      const signals = [];
      if (!a.joinedAt) signals.push("no joinedAt");
      if (!(a.meta && a.meta.designation)) signals.push("no designation");
      if (!(a.meta && a.meta.employeeId)) signals.push("no employeeId");
      return { adminId: a._id, name: a.name, email: a.email, signals };
    })
    .filter((r) => r.signals.length >= 3)
    .sort((x, y) => y.signals.length - x.signals.length);
};

module.exports = {
  isServiceAccount,
  employeeFilter,
  employedOn,
  employedOnDate,
  hasExited,
  listLikelyServiceAccounts,
};

const CompanyHoliday = require("../models/CompanyHoliday");
const PublicHoliday = require("../models/PublicHoliday");

// HR's own holiday calendar. See models/CompanyHoliday.js for why this is not
// a read of PublicHoliday.

const err = (status, message) => Object.assign(new Error(message), { status });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const list = async ({ from, to } = {}) => {
  const q = {};
  if (from || to) q.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return CompanyHoliday.find(q).sort({ date: 1 }).lean();
};

// Set of "YYYY-MM-DD" strings — what the sweep and the sheet ask for.
const holidayKeysBetween = async (from, to) => {
  const rows = await CompanyHoliday.find({ date: { $gte: from, $lte: to } }, { date: 1 }).lean();
  return new Set(rows.map((r) => r.date));
};

const upsert = async ({ date, name, paid = true }, actorId) => {
  if (!DAY_RE.test(String(date || ""))) throw err(400, 'date must be an IST day key "YYYY-MM-DD"');
  if (!String(name || "").trim()) throw err(400, "name is required");
  return CompanyHoliday.findOneAndUpdate(
    { date },
    { $set: { name: String(name).trim(), paid: paid !== false }, $setOnInsert: { createdBy: actorId || null } },
    { upsert: true, new: true }
  ).lean();
};

const remove = async (date) => {
  const res = await CompanyHoliday.deleteOne({ date });
  if (!res.deletedCount) throw err(404, "No company holiday on that date");
  return { date, removed: true };
};

// ── ONE-WAY SUGGESTED IMPORT ────────────────────────────────────────────────
// Reads PublicHoliday ONCE, to save HR typing a year of dates. It returns
// candidates and writes NOTHING: a human confirms each row via upsert(). That is
// the whole difference between a convenience and a dependency — payroll never
// reads that collection at decision time, so nobody editing the wedding-demand
// calendar can move a salary.
//
// Only NATIONAL rows are suggested. Regional rows carry the same holiday on a
// different date and a company has one calendar for one office; picking a region
// automatically is exactly the guess this design refuses to make.
const suggestFromPublicHolidays = async (year) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw err(400, "year must be a 4-digit year");
  const rows = await PublicHoliday.find({ year: y, type: "national" }, { date: 1, name: 1, verified: 1 })
    .sort({ date: 1 })
    .lean();
  const existing = new Set((await CompanyHoliday.find({}, { date: 1 }).lean()).map((r) => r.date));
  return rows.map((r) => ({
    // midnight-UTC Date → IST day key, the one conversion, done here and nowhere else.
    date: new Date(r.date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    name: r.name,
    // Surfaced so HR can see what they are accepting: PublicHoliday.verified
    // defaults to false and means "we read this somewhere", not "confirmed".
    sourceVerified: !!r.verified,
    alreadyAdded: existing.has(new Date(r.date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })),
  }));
};

module.exports = { list, holidayKeysBetween, upsert, remove, suggestFromPublicHolidays };

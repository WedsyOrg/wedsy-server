/**
 * controllers/weddingCalendarAdmin.js — admin CRUD for the two calendar
 * collections that are not the muhurat list: blackout periods and public
 * holidays.
 *
 * Same gate as the auspicious dates (auspicious_dates_manage): they are the
 * same body of platform reference data, entered by the same person in the same
 * sitting, and splitting the capability would mean a venue team that can enter
 * the muhurat calendar cannot say when the season closes — which is half the
 * calendar and the more consequential half, because a blackout is what stops an
 * owner chasing a date nobody will ever book.
 *
 * Resolution lives in utils/weddingCalendar; this file only writes.
 */
const BlackoutPeriod = require("../models/BlackoutPeriod");
const PublicHoliday = require("../models/PublicHoliday");
const { toDayKey, toDayStart, dayParts } = require("../utils/auspiciousDates");
const { cleanTraditions, TRADITIONS } = require("../utils/weddingTraditions");

const cleanRegion = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const cleanTraditionsInput = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const kept = cleanTraditions(list);
  return kept.length === list.filter(Boolean).length ? kept : false;
};

// ───────────────────────────── blackout periods ─────────────────────────────

// GET /admin/blackout-periods?year=
const listBlackoutPeriods = async (req, res) => {
  try {
    const filter = {};
    const { year } = req.query || {};
    if (year !== undefined && year !== "") {
      const y = parseInt(year, 10);
      if (!Number.isFinite(y) || y < 1970 || y > 2200) return res.status(400).json({ message: "year must be a 4-digit year" });
      // A period filed under 2026 can still run into 2027 (Kharmas), so the
      // year filter matches the FILED year OR any period whose range touches
      // that calendar year. Filtering on the column alone would hide Kharmas
      // from the 2027 screen, which is exactly the screen it matters on.
      const yearStart = new Date(Date.UTC(y, 0, 1));
      const yearEnd = new Date(Date.UTC(y, 11, 31));
      filter.$or = [{ year: y }, { startDate: { $lte: yearEnd }, endDate: { $gte: yearStart } }];
    }
    const periods = await BlackoutPeriod.find(filter).sort({ startDate: 1 }).lean();
    const unverified = periods.filter((p) => p.verified !== true).length;
    return res.status(200).json({ periods, total: periods.length, unverified });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /admin/blackout-periods { name, startDate, endDate, traditions?, notes?, verified? }
const createBlackoutPeriod = async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return res.status(400).json({ message: "name is required" });

    const startKey = toDayKey(body.startDate);
    const endKey = toDayKey(body.endDate);
    if (!startKey) return res.status(400).json({ message: "startDate must be a YYYY-MM-DD date" });
    if (!endKey) return res.status(400).json({ message: "endDate must be a YYYY-MM-DD date" });
    if (endKey < startKey) return res.status(400).json({ message: "endDate must not be before startDate" });

    const traditions = cleanTraditionsInput(body.traditions);
    if (traditions === false) return res.status(400).json({ message: `traditions must be from: ${TRADITIONS.join(", ")}` });

    const start = toDayStart(startKey);
    const doc = {
      name,
      startDate: start,
      endDate: toDayStart(endKey),
      traditions: traditions || [],
      // Filed under the year it STARTS in — see the model on why nothing
      // depends on this for a straddling period.
      year: dayParts(startKey).year,
      notes: typeof body.notes === "string" ? body.notes.trim() : "",
      verified: body.verified === true,
      createdBy: (req.auth && req.auth.user_id) || undefined,
    };

    // Idempotent on (name, startDate), same reasoning as the muhurat upsert:
    // re-running a seed or re-submitting a form must not lay down a second
    // Chaturmas.
    const period = await BlackoutPeriod.findOneAndUpdate(
      { name, startDate: start },
      { $set: doc },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(201).json({ period });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A period with that name already starts on that date" });
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /admin/blackout-periods/:id
const updateBlackoutPeriod = async (req, res) => {
  try {
    const row = await BlackoutPeriod.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "Blackout period not found" });
    const body = req.body || {};

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return res.status(400).json({ message: "name cannot be empty" });
      row.name = name;
    }
    // Unlike a muhurat date, a period's dates ARE editable: "Chaturmas actually
    // ends on the 3rd" is a correction to one row, not a different fact.
    const nextStartKey = body.startDate !== undefined ? toDayKey(body.startDate) : null;
    const nextEndKey = body.endDate !== undefined ? toDayKey(body.endDate) : null;
    if (body.startDate !== undefined && !nextStartKey) return res.status(400).json({ message: "startDate must be a YYYY-MM-DD date" });
    if (body.endDate !== undefined && !nextEndKey) return res.status(400).json({ message: "endDate must be a YYYY-MM-DD date" });
    const finalStart = nextStartKey || row.startDate.toISOString().slice(0, 10);
    const finalEnd = nextEndKey || row.endDate.toISOString().slice(0, 10);
    if (finalEnd < finalStart) return res.status(400).json({ message: "endDate must not be before startDate" });
    if (nextStartKey) {
      row.startDate = toDayStart(nextStartKey);
      row.year = dayParts(nextStartKey).year;
    }
    if (nextEndKey) row.endDate = toDayStart(nextEndKey);

    if (body.traditions !== undefined) {
      const t = cleanTraditionsInput(body.traditions);
      if (t === false) return res.status(400).json({ message: `traditions must be from: ${TRADITIONS.join(", ")}` });
      row.traditions = t;
    }
    if (body.notes !== undefined) row.notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (body.verified !== undefined) row.verified = body.verified === true;

    await row.save();
    return res.status(200).json({ period: row });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A period with that name already starts on that date" });
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /admin/blackout-periods/:id
const deleteBlackoutPeriod = async (req, res) => {
  try {
    const row = await BlackoutPeriod.findByIdAndDelete(req.params.id).lean();
    if (!row) return res.status(404).json({ message: "Blackout period not found" });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ───────────────────────────── public holidays ──────────────────────────────

// GET /admin/public-holidays?year=&type=&region=
const listPublicHolidays = async (req, res) => {
  try {
    const filter = {};
    const { year, type, region } = req.query || {};
    if (year !== undefined && year !== "") {
      const y = parseInt(year, 10);
      if (!Number.isFinite(y) || y < 1970 || y > 2200) return res.status(400).json({ message: "year must be a 4-digit year" });
      filter.year = y;
    }
    if (type !== undefined && type !== "") {
      if (!["national", "regional"].includes(type)) return res.status(400).json({ message: "type must be national or regional" });
      filter.type = type;
    }
    if (region !== undefined) filter.region = cleanRegion(region);

    const holidays = await PublicHoliday.find(filter).sort({ date: 1 }).lean();
    const unverified = holidays.filter((h) => h.verified !== true).length;
    // The regions actually present, so the UI can say "Karnataka 2027 is not
    // yet notified" from data instead of from a hardcoded list.
    const regions = [...new Set(holidays.map((h) => h.region).filter(Boolean))].sort();
    return res.status(200).json({ holidays, total: holidays.length, unverified, regions });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /admin/public-holidays — one row or a batch.
const createPublicHolidays = async (req, res) => {
  try {
    const body = req.body || {};
    const input = Array.isArray(body.holidays) ? body.holidays : [body];
    if (!input.length) return res.status(400).json({ message: "holidays must be a non-empty array" });
    if (input.length > 200) return res.status(400).json({ message: "Too many holidays in one call (max 200)" });

    const ops = [];
    for (const entry of input) {
      const key = toDayKey(entry && entry.date);
      if (!key) return res.status(400).json({ message: `date must be a YYYY-MM-DD date (got ${JSON.stringify(entry && entry.date)})` });
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) return res.status(400).json({ message: "each holiday needs a name" });
      const type = entry.type === "regional" ? "regional" : "national";
      const region = cleanRegion(entry.region) ?? null;
      // A regional holiday without a region is meaningless — it would resolve
      // for nobody and silently vanish from every venue's calendar.
      if (type === "regional" && !region) {
        return res.status(400).json({ message: `"${name}" is regional, so it needs a region` });
      }
      const start = toDayStart(key);
      ops.push({
        updateOne: {
          filter: { date: start, name, region },
          update: {
            $set: {
              type,
              notes: typeof entry.notes === "string" ? entry.notes.trim() : "",
              verified: entry.verified === true,
            },
            $setOnInsert: {
              date: start,
              name,
              region,
              year: dayParts(key).year,
              createdBy: (req.auth && req.auth.user_id) || undefined,
            },
          },
          upsert: true,
        },
      });
    }

    const result = await PublicHoliday.bulkWrite(ops, { ordered: false });
    return res.status(201).json({
      created: result.upsertedCount || 0,
      updated: result.matchedCount || 0,
      total: ops.length,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /admin/public-holidays/:id
const updatePublicHoliday = async (req, res) => {
  try {
    const row = await PublicHoliday.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "Public holiday not found" });
    const body = req.body || {};

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return res.status(400).json({ message: "name cannot be empty" });
      row.name = name;
    }
    if (body.date !== undefined) {
      const key = toDayKey(body.date);
      if (!key) return res.status(400).json({ message: "date must be a YYYY-MM-DD date" });
      row.date = toDayStart(key);
      row.year = dayParts(key).year;
    }
    if (body.type !== undefined) {
      if (!["national", "regional"].includes(body.type)) return res.status(400).json({ message: "type must be national or regional" });
      row.type = body.type;
    }
    if (body.region !== undefined) row.region = cleanRegion(body.region);
    if (row.type === "regional" && !row.region) {
      return res.status(400).json({ message: "a regional holiday needs a region" });
    }
    if (body.notes !== undefined) row.notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (body.verified !== undefined) row.verified = body.verified === true;

    await row.save();
    return res.status(200).json({ holiday: row });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "That holiday already exists on that date for that region" });
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /admin/public-holidays/:id
const deletePublicHoliday = async (req, res) => {
  try {
    const row = await PublicHoliday.findByIdAndDelete(req.params.id).lean();
    if (!row) return res.status(404).json({ message: "Public holiday not found" });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listBlackoutPeriods,
  createBlackoutPeriod,
  updateBlackoutPeriod,
  deleteBlackoutPeriod,
  listPublicHolidays,
  createPublicHolidays,
  updatePublicHoliday,
  deletePublicHoliday,
};

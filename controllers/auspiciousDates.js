/**
 * controllers/auspiciousDates.js — admin CRUD over the muhurat calendar.
 *
 * This is PLATFORM reference data: one collection read by the OS venue
 * department, the venue owner portal and (next) the couple site, so the write
 * surface is deliberately narrow and the resolution rule lives in exactly one
 * place (utils/auspiciousDates), never re-implemented per caller.
 *
 * Every handler runs behind CheckAdminLogin + requirePermission on
 * auspicious_dates_manage. The read that non-admins need is a separate,
 * venue-scoped route (GET /venues/:slug/auspicious-dates) — see controllers/venue.js.
 *
 * BULK CREATE IS AN UPSERT, ON PURPOSE. A year of dates is entered in batches,
 * by a human, off a printed panchang — the same month WILL get submitted twice.
 * Re-submitting a date must be a no-op, not a duplicate row and not an error,
 * so the write is an upsert keyed on the model's unique {date, region}.
 */
const AuspiciousDate = require("../models/AuspiciousDate");
const { toDayKey, toDayStart, dayParts } = require("../utils/auspiciousDates");
const { cleanTraditions, TRADITIONS } = require("../utils/weddingTraditions");

// A year is ~365 rows; the OS tab submits one month at a time. The cap is a
// guard against a runaway client, set far above any real batch.
const MAX_BATCH = 500;
const TIERS = ["major", "moderate"];

const cleanRegion = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s; // "" is how a form says "national"
};

const cleanTier = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null; // explicit "unspecified"
  return TIERS.includes(v) ? v : false; // false = invalid, caller 400s
};

// undefined = not supplied; false = supplied but contained something unknown,
// which is a 400 rather than a silent drop — a typo'd tradition that vanished
// would look like a successful save of the wrong data.
const cleanTraditionsInput = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const kept = cleanTraditions(list);
  return kept.length === list.filter(Boolean).length ? kept : false;
};

// GET /admin/auspicious-dates?year=&month=&region=
// year/month filter the denormalised columns (the month-grid read); region
// filters exactly — pass region= for national-only rows.
const listAuspiciousDates = async (req, res) => {
  try {
    const { year, month, region } = req.query || {};
    const filter = {};
    if (year !== undefined && year !== "") {
      const y = parseInt(year, 10);
      if (!Number.isFinite(y) || y < 1970 || y > 2200) return res.status(400).json({ message: "year must be a 4-digit year" });
      filter.year = y;
    }
    if (month !== undefined && month !== "") {
      const m = parseInt(month, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) return res.status(400).json({ message: "month must be 1-12" });
      filter.month = m;
    }
    // An explicitly EMPTY region means "national only" — distinct from omitting
    // the param, which means "every region".
    if (region !== undefined) filter.region = cleanRegion(region);
    // ?verified=false — the settings-UI review queue ("what still needs
    // checking against a panchang"). Absent = both.
    if (req.query.verified === "true") filter.verified = true;
    else if (req.query.verified === "false") filter.verified = { $ne: true };

    const dates = await AuspiciousDate.find(filter).sort({ date: 1 }).lean();
    const unverified = dates.filter((d) => d.verified !== true).length;
    return res.status(200).json({ dates, total: dates.length, unverified });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /admin/auspicious-dates
// Body: { dates: [...], tier?, region?, notes? } where each entry is either
// "YYYY-MM-DD" or { date, tier?, region?, notes? }. Per-entry values win over
// the batch-level defaults. Idempotent: a date already present is updated, not
// duplicated, and is reported as `updated` so the caller can tell the difference.
const bulkCreateAuspiciousDates = async (req, res) => {
  try {
    const body = req.body || {};
    const input = Array.isArray(body.dates) ? body.dates : null;
    if (!input || input.length === 0) {
      return res.status(400).json({ message: "dates must be a non-empty array" });
    }
    if (input.length > MAX_BATCH) {
      return res.status(400).json({ message: `Too many dates in one call (max ${MAX_BATCH})` });
    }

    const batchTier = cleanTier(body.tier);
    if (batchTier === false) return res.status(400).json({ message: `tier must be one of ${TIERS.join(", ")}` });
    const batchRegion = cleanRegion(body.region);
    const batchNotes = typeof body.notes === "string" ? body.notes.trim() : undefined;
    const batchTraditions = cleanTraditionsInput(body.traditions);
    if (batchTraditions === false) return res.status(400).json({ message: `traditions must be from: ${TRADITIONS.join(", ")}` });
    // Entering a date does not make it checked. `verified` is only ever set
    // true by the explicit review action, never as a side effect of a write.
    const batchVerified = body.verified === true;

    const ops = [];
    const invalid = [];
    const seen = new Set();
    for (const entry of input) {
      const raw = entry && typeof entry === "object" ? entry.date : entry;
      const key = toDayKey(raw);
      if (!key) {
        invalid.push(raw === undefined ? null : raw);
        continue;
      }
      const perTier = entry && typeof entry === "object" ? cleanTier(entry.tier) : undefined;
      if (perTier === false) return res.status(400).json({ message: `tier must be one of ${TIERS.join(", ")}` });
      const perRegion = entry && typeof entry === "object" ? cleanRegion(entry.region) : undefined;
      const perNotes = entry && typeof entry === "object" && typeof entry.notes === "string" ? entry.notes.trim() : undefined;
      const perTraditions = entry && typeof entry === "object" ? cleanTraditionsInput(entry.traditions) : undefined;
      if (perTraditions === false) return res.status(400).json({ message: `traditions must be from: ${TRADITIONS.join(", ")}` });

      const region = perRegion !== undefined ? perRegion : batchRegion !== undefined ? batchRegion : null;
      const tier = perTier !== undefined ? perTier : batchTier !== undefined ? batchTier : null;
      const notes = perNotes !== undefined ? perNotes : batchNotes !== undefined ? batchNotes : "";
      const rowTraditions = perTraditions !== undefined ? perTraditions : batchTraditions !== undefined ? batchTraditions : [];

      // Same (date, region) twice inside ONE batch would make two bulk ops race
      // on the unique index; collapse to the last one instead.
      const dedupeKey = `${key}|${region || ""}`;
      if (seen.has(dedupeKey)) {
        const at = ops.findIndex((o) => o.__key === dedupeKey);
        if (at >= 0) ops.splice(at, 1);
      }
      seen.add(dedupeKey);

      const start = toDayStart(key);
      const { year, month, day } = dayParts(key);
      ops.push({
        __key: dedupeKey,
        updateOne: {
          filter: { date: start, region },
          update: {
            // Traditions are SET, not merged, so correcting a mis-tagged date
            // is possible at all — a union would make "actually this is South
            // Indian only" unexpressible through the normal write path.
            $set: { tier, notes, traditions: rowTraditions, verified: batchVerified },
            $setOnInsert: {
              date: start,
              region,
              year,
              month,
              day,
              createdBy: (req.auth && req.auth.user_id) || undefined,
            },
          },
          upsert: true,
        },
      });
    }

    if (invalid.length) {
      return res.status(400).json({ message: "Some dates could not be read as calendar dates", invalid });
    }
    if (ops.length === 0) return res.status(400).json({ message: "No usable dates in the request" });

    const result = await AuspiciousDate.bulkWrite(ops.map(({ __key, ...op }) => op), { ordered: false });
    const created = result.upsertedCount || 0;
    // matchedCount counts rows that already existed — the idempotent re-entry.
    const updated = (result.matchedCount || 0);

    // Hand back the rows themselves so the caller can render without a refetch.
    const starts = ops.map((o) => o.updateOne.filter.date);
    const dates = await AuspiciousDate.find({ date: { $in: starts } }).sort({ date: 1 }).lean();

    return res.status(201).json({ created, updated, total: ops.length, dates });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /admin/auspicious-dates/:id — tier / notes / region.
// The date itself is immutable: "this row is a different day" is a delete plus
// an add, not an edit, and allowing it would silently move whatever the row
// already means.
const updateAuspiciousDate = async (req, res) => {
  try {
    const row = await AuspiciousDate.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "Auspicious date not found" });

    const body = req.body || {};
    if (body.date !== undefined) {
      return res.status(400).json({ message: "The date cannot be changed — delete this entry and add the correct one" });
    }
    if (body.tier !== undefined) {
      const tier = cleanTier(body.tier);
      if (tier === false) return res.status(400).json({ message: `tier must be one of ${TIERS.join(", ")}` });
      row.tier = tier;
    }
    if (body.notes !== undefined) row.notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (body.region !== undefined) row.region = cleanRegion(body.region);
    if (body.traditions !== undefined) {
      const t = cleanTraditionsInput(body.traditions);
      if (t === false) return res.status(400).json({ message: `traditions must be from: ${TRADITIONS.join(", ")}` });
      row.traditions = t;
    }
    // Verification is a human act, so it is set explicitly and can be revoked
    // explicitly — "I checked this and it was wrong" has to be expressible.
    if (body.verified !== undefined) row.verified = body.verified === true;

    await row.save();
    return res.status(200).json({ date: row });
  } catch (err) {
    // Moving a row onto a (date, region) that already exists.
    if (err.code === 11000) {
      return res.status(409).json({ message: "That date already has an entry for this region" });
    }
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /admin/auspicious-dates/:id
const deleteAuspiciousDate = async (req, res) => {
  try {
    const row = await AuspiciousDate.findByIdAndDelete(req.params.id).lean();
    if (!row) return res.status(404).json({ message: "Auspicious date not found" });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /admin/auspicious-dates/verify { year, month?, verified? }
// The review action. Checking a panchang happens a MONTH at a time — the page
// is a month — so flipping a month in one call is the shape of the actual work.
// Without it, verifying a seeded year is ~250 individual PATCHes and nobody
// does it, which would leave the whole calendar permanently marked provisional.
const verifyAuspiciousDates = async (req, res) => {
  try {
    const { year, month, verified } = req.body || {};
    const y = parseInt(year, 10);
    if (!Number.isFinite(y) || y < 1970 || y > 2200) {
      return res.status(400).json({ message: "year is required and must be a 4-digit year" });
    }
    const filter = { year: y };
    if (month !== undefined && month !== null && month !== "") {
      const m = parseInt(month, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) return res.status(400).json({ message: "month must be 1-12" });
      filter.month = m;
    }
    const next = verified === undefined ? true : verified === true;
    const result = await AuspiciousDate.updateMany(filter, { $set: { verified: next } });
    return res.status(200).json({ verified: next, matched: result.matchedCount || 0, modified: result.modifiedCount || 0 });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listAuspiciousDates,
  bulkCreateAuspiciousDates,
  updateAuspiciousDate,
  deleteAuspiciousDate,
  verifyAuspiciousDates,
  MAX_BATCH,
};

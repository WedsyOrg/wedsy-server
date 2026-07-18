// C4 — INSTAGRAM PLANNER engine. Board read (grouped + ordered + onTimePct),
// whitelisted writes, and the two daily-engine passes:
//   MONDAY ROLL — this_week leftovers → overdue:true + ONE manager alert
//                 (flaggedAt stamp), then next_week → this_week preserving
//                 relative order (appended after existing this_week cards).
//   STALE IDEAS — no activity in ideas/shortlisted for 3d → one episode-deduped
//                 nudge to CS members (EscalationMark, kind "content").
const ContentPost = require("../models/ContentPost");
const Admin = require("../models/Admin");
const EscalationMark = require("../models/EscalationMark");
const AdminNotificationService = require("./AdminNotificationService");
const CsAccessService = require("./CsAccessService");
const { filterAssignableIds } = require("../utils/assignable");
const { toIstWallClock } = require("../utils/goldenWindow");

const err = (status, message) => Object.assign(new Error(message), { status });

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 3;
const ONTIME_WINDOW_DAYS = 30;
const COLUMNS = ["ideas", "shortlisted", "next_week", "this_week", "posted"];
const SLOTS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// CS managers = active managers of CS members (reportingManagerId closure of
// one hop) — falling back to Revenue Heads when none exist.
const csManagerIds = async () => {
  const dept = await CsAccessService.csDepartment();
  const memberIds = await CsAccessService.csMemberIds(dept && dept._id);
  const members = memberIds.length
    ? await Admin.find({ _id: { $in: memberIds } }, { reportingManagerId: 1 }).lean()
    : [];
  const mgrIds = [...new Set(members.map((m) => String(m.reportingManagerId || "")).filter(Boolean))];
  const live = await filterAssignableIds(mgrIds);
  if (live.length) return live;
  return await require("./TriageService").revenueHeadIds();
};

// ── Board read ────────────────────────────────────────────────────────────────
const board = async (now = new Date()) => {
  const posts = await ContentPost.find({}).sort({ order: 1, createdAt: 1 }).lean();
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const p of posts) {
    if (columns[p.column]) columns[p.column].push(p);
  }
  columns.posted.sort((a, b) => +new Date(b.postedAt || 0) - +new Date(a.postedAt || 0));

  // onTimePct — posted in the last 30d.
  const cutoff = new Date(+now - ONTIME_WINDOW_DAYS * DAY_MS);
  const recent = posts.filter((p) => p.column === "posted" && p.postedAt && +new Date(p.postedAt) >= +cutoff);
  const onTimePct = recent.length
    ? Math.round((recent.filter((p) => p.onTime === true).length / recent.length) * 100)
    : null;

  return { columns, columnKeys: COLUMNS, onTimePct, generatedAt: now };
};

// ── Writes (whitelisted) ─────────────────────────────────────────────────────
const create = async ({ title, desc, column, slot } = {}, actorId) => {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw err(400, "A post needs a title.");
  const col = COLUMNS.includes(column) ? column : "ideas";
  if (col === "posted") throw err(400, "Create the card in a planning column — posting happens by moving it.");
  const s = SLOTS.includes(slot) ? slot : null;
  const last = await ContentPost.findOne({ column: col }).sort({ order: -1 }).lean();
  return (
    await ContentPost.create({
      title: cleanTitle.slice(0, 200),
      desc: String(desc || "").slice(0, 2000),
      column: col,
      slot: s,
      order: last ? last.order + 1 : 0,
      createdBy: actorId || null,
    })
  ).toObject();
};

const patch = async (id, fields = {}) => {
  const doc = await ContentPost.findById(id);
  if (!doc) throw err(404, "Post not found");
  const set = {};
  if (fields.title !== undefined) {
    const t = String(fields.title || "").trim();
    if (!t) throw err(400, "A post needs a title.");
    set.title = t.slice(0, 200);
  }
  if (fields.desc !== undefined) set.desc = String(fields.desc || "").slice(0, 2000);
  if (fields.slot !== undefined) {
    if (fields.slot !== null && !SLOTS.includes(fields.slot)) throw err(400, `slot must be one of ${SLOTS.join("|")} or null`);
    set.slot = fields.slot;
  }
  if (fields.order !== undefined) {
    const o = Number(fields.order);
    if (!Number.isFinite(o) || o < 0) throw err(400, "order must be a non-negative number");
    set.order = o;
  }
  if (fields.column !== undefined) {
    if (!COLUMNS.includes(fields.column)) throw err(400, `column must be one of ${COLUMNS.join("|")}`);
    set.column = fields.column;
    if (fields.column === "posted" && doc.column !== "posted") {
      set.postedAt = new Date();
      set.onTime = !doc.overdue; // posted without ever going overdue
    }
    if (fields.column !== "posted" && doc.column === "posted") {
      set.postedAt = null;
      set.onTime = null;
    }
  }
  await ContentPost.updateOne({ _id: doc._id }, { $set: set });
  return await ContentPost.findById(doc._id).lean();
};

const remove = async (id) => {
  const r = await ContentPost.deleteOne({ _id: id });
  if (!r.deletedCount) throw err(404, "Post not found");
  return { ok: true };
};

// ── Sweep passes (daily engine) ──────────────────────────────────────────────
// MONDAY ROLL. IST-Monday-gated (opts.force for tests). Order preserved:
// rolled cards keep their relative order, appended after existing this_week.
const mondayRoll = async (now = new Date(), opts = {}) => {
  const isMonday = toIstWallClock(now).getUTCDay() === 1;
  if (!isMonday && !opts.force) return { rolled: 0, flaggedOverdue: 0, skipped: "not monday" };

  // 1 · leftovers in this_week → overdue + one-time manager alert.
  const leftovers = await ContentPost.find({ column: "this_week", postedAt: null }).lean();
  let flaggedOverdue = 0;
  if (leftovers.length) {
    const managers = await csManagerIds();
    for (const p of leftovers) {
      const set = { overdue: true };
      const firstFlag = !p.flaggedAt;
      if (firstFlag) set.flaggedAt = now;
      await ContentPost.updateOne({ _id: p._id }, { $set: set });
      if (firstFlag && managers.length) {
        await AdminNotificationService.notify(managers, {
          type: "content_overdue",
          title: `"${p.title}" was due last week`,
          message: "The card stays in This week, marked overdue, until it's posted.",
          payload: { contentPostId: String(p._id) },
        });
        flaggedOverdue += 1;
      }
    }
  }

  // 2 · roll next_week → this_week, preserving relative order.
  const maxThis = await ContentPost.findOne({ column: "this_week" }).sort({ order: -1 }).lean();
  let base = maxThis ? maxThis.order + 1 : 0;
  const rolling = await ContentPost.find({ column: "next_week" }).sort({ order: 1, createdAt: 1 }).lean();
  for (const p of rolling) {
    await ContentPost.updateOne({ _id: p._id }, { $set: { column: "this_week", order: base } });
    base += 1;
  }
  return { rolled: rolling.length, flaggedOverdue };
};

// STALE IDEAS. Episode anchor = the newest activity (updatedAt) in
// ideas/shortlisted; one nudge per episode (new activity → new anchor → new key).
const staleIdeasSweep = async (now = new Date()) => {
  const newest = await ContentPost.findOne({ column: { $in: ["ideas", "shortlisted"] } })
    .sort({ updatedAt: -1 })
    .lean();
  if (!newest) return { stale: false };
  const anchor = +new Date(newest.updatedAt);
  if (+now - anchor < STALE_DAYS * DAY_MS) return { stale: false };

  try {
    await EscalationMark.create({
      key: `content:global:stale:1:${anchor}`,
      leadId: null,
      kind: "content",
      rung: 1,
    });
  } catch (e) {
    if (e && e.code === 11000) return { stale: true, notified: false }; // this episode already nudged
    throw e;
  }
  const dept = await CsAccessService.csDepartment();
  const members = await filterAssignableIds(await CsAccessService.csMemberIds(dept && dept._id));
  if (members.length) {
    await AdminNotificationService.notify(members, {
      type: "content_stale",
      title: "The content pipeline is quiet",
      message: `No movement in Ideas/Shortlisted for ${STALE_DAYS} days — add or shortlist something.`,
      payload: { staleDays: STALE_DAYS },
    });
  }
  return { stale: true, notified: members.length > 0 };
};

module.exports = { board, create, patch, remove, mondayRoll, staleIdeasSweep, csManagerIds, COLUMNS, SLOTS };

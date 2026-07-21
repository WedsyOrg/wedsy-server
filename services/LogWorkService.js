// A8 — LOG WORK: the honesty mechanism. Composes a DETERMINISTIC, terse brief
// of NET changes since lastLoggedAt from the plan_change event stream — NO AI,
// no credits, pure counting. Net-zero churn (remove 1 + add 1) reads "No
// material changes since last update"; brevity is the anti-gaming feature.
// Commit posts to the Décor lane: the system brief as an ITALIC-flagged auto
// entry (machine, untouchable) + the planner's own words as a plain update
// below; resets the lane silence clock and soft-notifies the lead owner.
const mongoose = require("mongoose");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadPlan = require("../models/LeadPlan");
const Admin = require("../models/Admin");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const NO_CHANGES = "No material changes since last update.";

// NET reduction: per (kind · draftName) bucket, adds minus deletes; edits
// counted once per touched thing. Deterministic templating only.
const composeBrief = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const plan = await LeadPlan.findOne({ leadId }, { lastLoggedAt: 1 }).lean();
  const since = plan && plan.lastLoggedAt ? plan.lastLoggedAt : new Date(0);
  const events = await LeadInternalEvent.find(
    { leadId, type: "plan_change", createdAt: { $gt: since } },
    { payload: 1, createdAt: 1, actorId: 1 }
  )
    .sort({ createdAt: 1 })
    .lean();

  if (!events.length) return { systemBrief: NO_CHANGES, since, changeCount: 0, net: {} };

  // Buckets: kind:draftName → { adds, deletes, edits, names:Set }
  const buckets = new Map();
  const bucket = (kind, scope) => {
    const key = `${kind}::${scope || ""}`;
    if (!buckets.has(key)) buckets.set(key, { kind, scope: scope || "", adds: 0, deletes: 0, edits: 0, names: new Set() });
    return buckets.get(key);
  };
  for (const e of events) {
    const p = e.payload || {};
    const scope = p.draftName || (p.kind === "look" ? "shortlist" : "");
    const b = bucket(p.kind || "item", scope);
    const n = Number(p.count) || 1;
    if (p.op === "add") b.adds += n;
    else if (p.op === "delete") b.deletes += n;
    else b.edits += 1; // edit / finalise / unlock / publish / revoke — one line each way below
    if (p.name) b.names.add(String(p.name));
    if (p.op === "finalise") b.finalised = true;
    if (p.op === "publish") b.published = true;
    if (p.op === "unlock") b.unlocked = true;
    if (p.op === "revoke") b.revoked = true;
  }

  const lines = [];
  for (const b of buckets.values()) {
    const net = b.adds - b.deletes;
    const label = b.kind === "look" ? "look" : b.kind === "package" ? "package" : b.kind === "day" ? "day" : b.kind === "theme_selection" ? "theme" : b.kind === "draft" ? "draft" : "item";
    const scope = b.scope ? ` in ${b.scope}` : "";
    if (b.kind === "draft") {
      if (b.finalised) lines.push(`${b.scope || [...b.names][0] || "draft"} finalised`);
      if (b.unlocked) lines.push(`${b.scope || [...b.names][0] || "draft"} unlocked for amendment`);
      if (b.published) lines.push(`${b.scope || [...b.names][0] || "draft"} published to the couple`);
      if (b.revoked) lines.push(`${b.scope || [...b.names][0] || "draft"} pulled back`);
      continue;
    }
    if (b.kind === "theme_selection") {
      lines.push(`theme set: ${[...b.names].slice(0, 3).join(", ")}`);
      continue;
    }
    if (net > 0) lines.push(`+${net} ${label}${net === 1 ? "" : "s"}${scope}`);
    else if (net < 0) lines.push(`−${-net} ${label}${-net === 1 ? "" : "s"}${scope}`);
    else if (b.edits > 0) lines.push(`${b.edits} ${label} edit${b.edits === 1 ? "" : "s"}${scope}`);
    // net zero with no edits → churn → say nothing (that's the point)
  }

  const systemBrief = lines.length ? `Décor: ${lines.join(" · ")}` : NO_CHANGES;
  return { systemBrief, since, changeCount: events.length, netLines: lines };
};

// Commit — posts to the Décor lane, resets the heartbeat, notifies, stamps.
const commit = async (leadId, { systemBrief, plannerAppend } = {}, actorId) => {
  const brief = String(systemBrief || "").trim();
  if (!brief) throw err(400, "Compose the brief first (POST /plan/log-work).");
  const LeadLane = require("../models/LeadLane");
  const lane = await LeadLane.findOne({ leadId, key: "decor" });
  if (!lane) throw err(404, "No Décor lane on this lead yet — assemble the team first.");

  const LaneEntry = require("../models/LaneEntry");
  const now = new Date();
  // The machine brief: kind "auto" + autoType "log_work" → the FE renders it
  // ITALIC (system-composed, untouchable). authorId kept for attribution.
  const systemEntry = await LaneEntry.create({
    laneId: lane._id,
    leadId,
    kind: "auto",
    autoType: "log_work",
    text: brief.slice(0, 3000),
    authorId: actorId || null,
    at: now,
  });
  // The planner's own words: a PLAIN update below (their voice, their claim).
  let appendEntry = null;
  const append = String(plannerAppend || "").trim();
  if (append) {
    appendEntry = await LaneEntry.create({
      laneId: lane._id,
      leadId,
      kind: "update",
      text: append.slice(0, 3000),
      authorId: actorId || null,
      at: new Date(+now + 1),
    });
  }
  // HEARTBEAT: logging work resets the lane silence clock.
  lane.lastUpdateAt = new Date();
  await lane.save();

  // Watermark + soft-notify the lead owner.
  await LeadPlan.updateOne({ leadId }, { $set: { lastLoggedAt: new Date() } }, { upsert: true });
  try {
    const Enquiry = require("../models/Enquiry");
    const lead = await Enquiry.findById(leadId, { name: 1, assignedTo: 1 }).lean();
    const { filterAssignableIds } = require("../utils/assignable");
    const recipients = lead && lead.assignedTo ? await filterAssignableIds([lead.assignedTo]) : [];
    const planner = actorId ? await Admin.findById(actorId, { name: 1 }).lean() : null;
    if (recipients.length && String(lead.assignedTo) !== String(actorId || "")) {
      await require("./AdminNotificationService").notify(recipients, {
        type: "plan_log",
        title: `Décor update on ${lead.name}${planner ? ` — ${planner.name}` : ""}`,
        message: brief.slice(0, 500),
        leadId,
        payload: { laneId: String(lane._id) },
      });
    }
  } catch (e) {
    console.error("[LogWork] notify failed:", e.message);
  }
  return {
    systemEntry: systemEntry.toObject(),
    appendEntry: appendEntry ? appendEntry.toObject() : null,
    heartbeat: true,
  };
};

module.exports = { composeBrief, commit, NO_CHANGES };

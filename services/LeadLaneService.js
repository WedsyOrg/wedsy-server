// Slice B3 — THE LANE ENGINE. Workstream lanes on a qualified lead: proposal
// derivation from discovery, one-shot team assembly, single-lane CRUD, human
// updates (the silence heartbeat) and fire-safe auto entries hooked from the
// existing action services (logCall / meeting booked / proposal sent / task
// done). Nothing here ever breaks a primary action.
const mongoose = require("mongoose");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const Enquiry = require("../models/Enquiry");
const Department = require("../models/Department");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadInternalEventService = require("./LeadInternalEventService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const LANE_STATES = ["queued", "active", "paused", "done"];
const WAKE_TYPES = ["afterLane", "onDate", "manual"];

// The canonical lane library. custom:* keys are allowed on top.
const LANE_LIBRARY = {
  venue: "Venue",
  decor: "Décor",
  makeup: "Makeup",
  vendors: "Vendors",
  engagement: "Client engagement",
  lead_comms: "Lead communication",
  kickoff: "Kickoff & alignment",
};
const isValidKey = (key) =>
  Object.prototype.hasOwnProperty.call(LANE_LIBRARY, key) ||
  (/^custom:[a-z0-9-]{1,40}$/.test(String(key)));

// Valid state transitions: queued→active, active⇄paused, any→done.
const canTransition = (from, to) => {
  if (from === to) return true;
  if (to === "done") return true;
  if (from === "queued" && to === "active") return true;
  if (from === "active" && to === "paused") return true;
  if (from === "paused" && to === "active") return true;
  return false;
};

// Map a discovery service string to a lane key. Unmapped services fold into
// ONE "vendors" lane.
const laneKeyForService = (service) => {
  const s = String(service || "").toLowerCase();
  if (/venue/.test(s)) return "venue";
  if (/d[eé]cor/.test(s)) return "decor";
  if (/makeup|mua|beauty/.test(s)) return "makeup";
  return "vendors";
};

// Suggested department + owner for a lane: a Department whose name contains the
// lane name (or vice versa), then a CURRENT roster member serving it.
const suggestFor = async (leadId, laneName) => {
  const [departments, roster] = await Promise.all([
    Department.find({ deletedAt: null }, { name: 1 }).lean().catch(() => []),
    LeadTeamMemberRepository.findCurrentByLead(leadId),
  ]);
  const lc = laneName.toLowerCase();
  const dept =
    departments.find((d) => {
      const dn = String(d.name || "").toLowerCase();
      return dn.includes(lc) || lc.includes(dn);
    }) || null;
  const member = dept
    ? roster.find((r) => r.departmentId && String(r.departmentId) === String(dept._id)) || null
    : null;
  return {
    departmentId: dept ? String(dept._id) : null,
    suggestedOwnerId: member ? String(member.personId) : null,
  };
};

// GET — lanes (+ last entry each). When the lead has NO lanes yet, also return
// the assembly PROPOSAL derived from discovery + the standing lanes.
const listLanes = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1, qualificationData: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const lanes = await LeadLane.find({ leadId }).sort({ createdAt: 1 }).lean();
  let lastByLane = new Map();
  if (lanes.length) {
    const latest = await LaneEntry.aggregate([
      { $match: { laneId: { $in: lanes.map((l) => l._id) } } },
      { $sort: { at: -1 } },
      { $group: { _id: "$laneId", entry: { $first: "$$ROOT" } } },
    ]);
    lastByLane = new Map(latest.map((r) => [String(r._id), r.entry]));
  }
  const decorated = lanes.map((l) => ({ ...l, lastEntry: lastByLane.get(String(l._id)) || null }));

  if (lanes.length) return { lanes: decorated, proposal: [] };

  // ── Proposal derivation (no lanes yet) ──
  const q = lead.qualificationData || {};
  const keys = new Set();
  for (const s of q.servicesRequired || []) keys.add(laneKeyForService(s));
  // Venue only when the venue is NOT already booked.
  if (keys.has("venue") && q.venueStatus === "booked") keys.delete("venue");
  const proposal = [];
  for (const key of keys) {
    const name = LANE_LIBRARY[key];
    const sug = await suggestFor(leadId, name);
    proposal.push({ key, name, tag: "from discovery", ...sug, locked: false });
  }
  // Standing lanes: lead_comms (locked to the lead owner) + engagement + kickoff.
  proposal.push({
    key: "lead_comms",
    name: LANE_LIBRARY.lead_comms,
    tag: "standing",
    departmentId: null,
    suggestedOwnerId: lead.assignedTo ? String(lead.assignedTo) : null,
    locked: true,
  });
  for (const key of ["engagement", "kickoff"]) {
    const sug = await suggestFor(leadId, LANE_LIBRARY[key]);
    proposal.push({ key, name: LANE_LIBRARY[key], tag: "standing", ...sug, locked: false });
  }
  return { lanes: [], proposal };
};

const laneOpenedEntry = (lane) =>
  LaneEntry.create({
    laneId: lane._id,
    leadId: lane.leadId,
    kind: "auto",
    autoType: "lane_opened",
    text: "Lane opened",
    authorId: null,
    at: new Date(),
  });

const normalizeWake = (wake) => {
  if (!wake) return null;
  if (!WAKE_TYPES.includes(wake.type)) throw err(400, `wake.type must be one of: ${WAKE_TYPES.join(", ")}`);
  if (wake.type === "afterLane" && !wake.laneKey) throw err(400, "wake.laneKey is required for afterLane");
  if (wake.type === "onDate") {
    const d = new Date(wake.at);
    if (!wake.at || Number.isNaN(d.getTime())) throw err(400, "wake.at must be a valid date for onDate");
    return { type: "onDate", at: d };
  }
  return wake.type === "afterLane" ? { type: "afterLane", laneKey: String(wake.laneKey) } : { type: "manual" };
};

// POST /lanes/assemble — one-shot team assembly. Idempotent per key (existing
// lanes are left untouched). lead_comms owner is FORCED to the lead owner.
const assemble = async (leadId, { lanes } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  if (!Array.isArray(lanes) || !lanes.length) throw err(400, "lanes[] is required");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const existing = await LeadLane.find({ leadId }, { key: 1 }).lean();
  const have = new Set(existing.map((l) => l.key));

  const created = [];
  for (const spec of lanes) {
    const key = String(spec.key || "");
    if (!isValidKey(key)) throw err(400, `Invalid lane key: ${key}`);
    if (have.has(key)) continue; // idempotent
    const name = String(spec.name || LANE_LIBRARY[key] || "").trim();
    if (!name) throw err(400, `Lane ${key} needs a name`);
    const state = spec.state && LANE_STATES.includes(spec.state) ? spec.state : "active";
    const wake = state === "queued" ? normalizeWake(spec.wake) : null;
    const ownerId =
      key === "lead_comms"
        ? lead.assignedTo || null // the single voice — never client-chosen
        : spec.ownerId && isId(spec.ownerId)
          ? spec.ownerId
          : null;
    const lane = await LeadLane.create({
      leadId,
      key,
      name,
      departmentId: spec.departmentId && isId(spec.departmentId) ? spec.departmentId : null,
      ownerId,
      state,
      wake,
      lastUpdateAt: new Date(),
      createdBy: actorId || null,
    });
    await laneOpenedEntry(lane);
    created.push(lane);
    have.add(key);
  }

  await LeadInternalEventService.record({
    leadId,
    type: "team_assembled",
    actorId: actorId || null,
    payload: { lanes: created.map((l) => l.key), count: created.length },
  });

  return listLanes(leadId);
};

// POST /lanes — add ONE lane later (same rules as assemble).
const addLane = async (leadId, spec = {}, actorId) => {
  const result = await assemble(leadId, { lanes: [spec] }, actorId);
  return result;
};

// PATCH /lanes/:laneId — owner / state / wake / pausedReason.
const patchLane = async (leadId, laneId, fields = {}, actorId) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId });
  if (!lane) throw err(404, "Lane not found");

  if (fields.ownerId !== undefined) {
    if (lane.key === "lead_comms") throw err(400, "Lead communication stays with the lead owner");
    if (fields.ownerId !== null && !isId(fields.ownerId)) throw err(400, "Invalid ownerId");
    lane.ownerId = fields.ownerId || null;
  }
  if (fields.state !== undefined) {
    if (!LANE_STATES.includes(fields.state)) throw err(400, `state must be one of: ${LANE_STATES.join(", ")}`);
    if (!canTransition(lane.state, fields.state)) {
      throw err(422, `Invalid transition ${lane.state} → ${fields.state}`);
    }
    lane.state = fields.state;
    if (fields.state === "done") lane.doneAt = new Date();
    if (fields.state === "active") { lane.wake = null; lane.pausedReason = ""; }
    lane.lastUpdateAt = new Date(); // a state change IS a heartbeat
  }
  if (fields.pausedReason !== undefined) {
    lane.pausedReason = String(fields.pausedReason || "");
  }
  if (fields.wake !== undefined) {
    if (lane.state !== "queued" && fields.wake) throw err(400, "wake only applies to a queued lane");
    lane.wake = fields.wake ? normalizeWake(fields.wake) : null;
  }
  await lane.save();
  return lane.toObject();
};

// POST /lanes/:laneId/entries — a HUMAN update: the lane heartbeat. Bumps the
// lane's lastUpdateAt AND the lead's activity spine.
const addEntry = async (leadId, laneId, { text } = {}, actorId) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const clean = String(text || "").trim();
  if (!clean) throw err(400, "An update needs text");
  const lane = await LeadLane.findOne({ _id: laneId, leadId });
  if (!lane) throw err(404, "Lane not found");
  const entry = await LaneEntry.create({
    laneId,
    leadId,
    kind: "update",
    text: clean.slice(0, 3000),
    authorId: actorId || null,
    at: new Date(),
  });
  lane.lastUpdateAt = new Date();
  await lane.save();
  await EnquiryRepository.touchLastActivity(leadId);
  return entry.toObject();
};

// GET /lanes/:laneId/entries — the FULL thread, oldest-first.
const listEntries = async (leadId, laneId, { limit } = {}) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }).lean();
  if (!lane) throw err(404, "Lane not found");
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const list = await LaneEntry.find({ laneId }).sort({ at: 1 }).limit(lim).lean();
  return { lane: { _id: lane._id, key: lane.key, name: lane.name }, list };
};

// FIRE-SAFE auto entry by lane KEY (used by the action-service hooks). No-op
// when the lead has no such lane; never throws.
const autoEntry = async (leadId, laneKey, autoType, text) => {
  try {
    const lane = await LeadLane.findOne({ leadId, key: laneKey });
    if (!lane) return null;
    const entry = await LaneEntry.create({
      laneId: lane._id,
      leadId,
      kind: "auto",
      autoType: autoType || "",
      text: String(text || "").slice(0, 500),
      authorId: null,
      at: new Date(),
    });
    lane.lastUpdateAt = new Date();
    await lane.save();
    return entry;
  } catch (e) {
    console.error("[LeadLaneService.autoEntry] failed:", e.message);
    return null;
  }
};

// Fire-safe auto entry by lane ID (task hooks know the lane directly).
const autoEntryByLaneId = async (laneId, autoType, text) => {
  try {
    const lane = await LeadLane.findById(laneId);
    if (!lane) return null;
    const entry = await LaneEntry.create({
      laneId: lane._id,
      leadId: lane.leadId,
      kind: "auto",
      autoType: autoType || "",
      text: String(text || "").slice(0, 500),
      authorId: null,
      at: new Date(),
    });
    lane.lastUpdateAt = new Date();
    await lane.save();
    return entry;
  } catch (e) {
    console.error("[LeadLaneService.autoEntryByLaneId] failed:", e.message);
    return null;
  }
};

module.exports = {
  LANE_LIBRARY,
  listLanes,
  listEntries,
  assemble,
  addLane,
  patchLane,
  addEntry,
  autoEntry,
  autoEntryByLaneId,
  canTransition,
};

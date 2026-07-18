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
const { filterAssignableIds, isAssignableAdmin } = require("../utils/assignable");

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
// Journey v2 (V4): vendor:{service} sub-lanes — one per non-core service, all
// grouped under the Vendors header client-side via groupKey (no string parsing).
const isValidKey = (key) =>
  Object.prototype.hasOwnProperty.call(LANE_LIBRARY, key) ||
  (/^custom:[a-z0-9-]{1,40}$/.test(String(key))) ||
  (/^vendor:[a-z0-9-]{1,40}$/.test(String(key)));

const vendorSlug = (service) =>
  String(service || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
const vendorNameFromKey = (key) =>
  String(key)
    .slice("vendor:".length)
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ")
    .trim();
const groupKeyFor = (key) =>
  String(key).startsWith("vendor:") || key === "vendors" ? "vendors" : null;

// Journey v2 (V3): additive display labels over the EXISTING states — no
// state-machine changes. paused reads "Awaiting client" only when the pause is
// client-caused (the canonical pausedReason "client", written by the
// awaiting_client label below and by /block).
const displayStatusOf = (lane) => {
  if (lane.state === "active") return "Started";
  if (lane.state === "done") return "Done";
  if (lane.state === "paused") {
    return /client/i.test(lane.pausedReason || "") ? "Awaiting client" : "On hold";
  }
  return "On hold"; // queued
};
// The four accepted labels (snake keys or display strings) → state fields.
const DISPLAY_TO_STATE = {
  started: { state: "active" },
  "awaiting client": { state: "paused", pausedReason: "client" },
  awaiting_client: { state: "paused", pausedReason: "client" },
  "on hold": { state: "paused" },
  on_hold: { state: "paused" },
  done: { state: "done" },
};

// Valid state transitions: queued→active, active⇄paused, any→done.
const canTransition = (from, to) => {
  if (from === to) return true;
  if (to === "done") return true;
  if (from === "queued" && to === "active") return true;
  if (from === "active" && to === "paused") return true;
  if (from === "paused" && to === "active") return true;
  return false;
};

// Map a discovery service string to a lane key. Journey v2 (V4): non-core
// services each get their OWN vendor:{service} sub-lane (was: one folded
// "vendors" lane) — independent owners, clocks and escalation per service.
const laneKeyForService = (service) => {
  const s = String(service || "").toLowerCase();
  if (/venue/.test(s)) return "venue";
  if (/d[eé]cor/.test(s)) return "decor";
  if (/makeup|mua|beauty/.test(s)) return "makeup";
  const slug = vendorSlug(service);
  return slug ? `vendor:${slug}` : "vendors";
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
  // Only suggest a roster member who can actually receive work — a disabled
  // admin must never be offered as a lane owner.
  const assignableRoster = new Set(
    (await filterAssignableIds(roster.map((r) => r.personId))).map(String)
  );
  const member = dept
    ? roster.find(
        (r) =>
          r.departmentId &&
          String(r.departmentId) === String(dept._id) &&
          assignableRoster.has(String(r.personId))
      ) || null
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
  // Journey v2: displayStatus (V3 labels), price + priced (V3 money), and
  // groupKey (V4 vendor grouping) ride every lane row additively.
  const decorated = lanes.map((l) => ({
    ...l,
    lastEntry: lastByLane.get(String(l._id)) || null,
    displayStatus: displayStatusOf(l),
    price: l.price || null,
    priced: !!(l.price && l.price.amount != null),
    groupKey: groupKeyFor(l.key),
  }));

  if (lanes.length) return { lanes: decorated, proposal: [] };

  // ── Proposal derivation (no lanes yet) ──
  const q = lead.qualificationData || {};
  // key → the display name (vendor lanes keep the raw service string as name).
  const keyNames = new Map();
  for (const s of q.servicesRequired || []) {
    const key = laneKeyForService(s);
    if (!keyNames.has(key)) {
      keyNames.set(
        key,
        LANE_LIBRARY[key] || (key.startsWith("vendor:") ? String(s).trim() : String(s).trim())
      );
    }
  }
  // Venue only when the venue is NOT already booked.
  if (keyNames.has("venue") && q.venueStatus === "booked") keyNames.delete("venue");
  const proposal = [];
  for (const [key, name] of keyNames) {
    const sug = await suggestFor(leadId, name);
    proposal.push({
      key,
      name,
      tag: "from discovery",
      ...sug,
      locked: false,
      groupKey: groupKeyFor(key),
    });
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
    const name = String(
      spec.name ||
        LANE_LIBRARY[key] ||
        (key.startsWith("vendor:") ? vendorNameFromKey(key) : "")
    ).trim();
    if (!name) throw err(400, `Lane ${key} needs a name`);
    const state = spec.state && LANE_STATES.includes(spec.state) ? spec.state : "active";
    const wake = state === "queued" ? normalizeWake(spec.wake) : null;
    // lead_comms owner is FORCED to the lead owner (never client-chosen). For
    // other lanes, a client-chosen owner must be a live, assignable admin — a
    // disabled pick is dropped to null (the lane stays unowned and surfaces via
    // lane escalation) rather than silently handing work to a disabled admin.
    let ownerId =
      key === "lead_comms"
        ? lead.assignedTo || null
        : spec.ownerId && isId(spec.ownerId)
          ? spec.ownerId
          : null;
    if (key !== "lead_comms" && ownerId && !(await isAssignableAdmin(ownerId))) {
      ownerId = null;
    }
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

  // Journey v2 (V3): the four display labels map back onto the EXISTING state
  // machine (awaiting_client → paused + the canonical "client" reason). Same
  // canTransition guard as a raw state patch — no new transitions.
  if (fields.displayStatus !== undefined && fields.state === undefined) {
    const mapped = DISPLAY_TO_STATE[String(fields.displayStatus || "").trim().toLowerCase()];
    if (!mapped) {
      throw err(400, 'displayStatus must be one of: "Started", "Awaiting client", "On hold", "Done"');
    }
    fields = { ...fields, state: mapped.state };
    if (mapped.pausedReason !== undefined) fields.pausedReason = mapped.pausedReason;
  }

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

// ── Journey v2 (V3) — per-lane money ─────────────────────────────────────────
// scopeOk = "the caller's lead scope covers this lead" (computed by the
// controller from req.scopeFilter — the lead owner/manager test).
// Propose: lane OWNER or lead owner/manager. Confirm: lead owner/manager ONLY.
const fmtAmount = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

const proposePrice = async (leadId, laneId, amount, actorId, scopeOk) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw err(400, "A positive amount is required");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }).lean();
  if (!lane) throw err(404, "Lane not found");
  const isLaneOwner = lane.ownerId && String(lane.ownerId) === String(actorId);
  if (!isLaneOwner && !scopeOk) throw err(403, "Only the lane owner or the lead owner/manager can price this lane");

  const price = {
    amount: amt,
    status: "proposed",
    proposedBy: actorId || null,
    proposedAt: new Date(),
    confirmedBy: null,
    confirmedAt: null,
  };
  await LeadLane.updateOne({ _id: lane._id }, { $set: { price } });
  await autoEntryByLaneId(lane._id, "lane_priced", `Priced ${fmtAmount(amt)} — awaiting lead owner`);
  await LeadInternalEventService.record({
    leadId,
    type: "lane_priced",
    actorId: actorId || null,
    payload: { laneId: String(lane._id), laneKey: lane.key, amount: amt },
  });
  return { price, priced: true, displayStatus: displayStatusOf(lane) };
};

const confirmPrice = async (leadId, laneId, actorId, scopeOk) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  if (!scopeOk) throw err(403, "Only the lead owner/manager can confirm a lane price");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }).lean();
  if (!lane) throw err(404, "Lane not found");
  if (!lane.price || lane.price.amount == null) throw err(409, "No proposed price to confirm");
  if (lane.price.status === "confirmed") return { price: lane.price, alreadyConfirmed: true };

  const price = { ...lane.price, status: "confirmed", confirmedBy: actorId || null, confirmedAt: new Date() };
  await LeadLane.updateOne({ _id: lane._id }, { $set: { price } });
  await autoEntryByLaneId(lane._id, "lane_priced", `Price confirmed ${fmtAmount(price.amount)}`);
  await LeadInternalEventService.record({
    leadId,
    type: "lane_price_confirmed",
    actorId: actorId || null,
    payload: { laneId: String(lane._id), laneKey: lane.key, amount: price.amount },
  });
  return { price };
};

// ── Journey v2 (V5) — the engagement pulse ────────────────────────────────────
// Marking a library item "sent" is a HUMAN update on the engagement lane: it
// resets the silence clock (kind "update") and lands in the sent log. autoType
// "engagement_sent" tags the row so the log read never string-parses.
const markEngagementSent = async (leadId, laneId, itemId, actorId, scopeOk) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId });
  if (!lane) throw err(404, "Lane not found");
  if (lane.key !== "engagement") throw err(400, "engagement-sent applies to the engagement lane only");
  const isLaneOwner = lane.ownerId && String(lane.ownerId) === String(actorId);
  if (!isLaneOwner && !scopeOk) throw err(403, "Only the engagement lane owner or the lead owner can mark content sent");

  const SettingsService = require("./SettingsService");
  const items = (await SettingsService.get("engagement.items")) || [];
  const item = items.find((i) => i && i.id === String(itemId || ""));
  if (!item) throw err(404, "Content item not found in the library");
  if (item.active === false) throw err(422, "This content item is inactive");

  const entry = await LaneEntry.create({
    laneId: lane._id,
    leadId,
    kind: "update", // the heartbeat — resets the silence/pulse clock
    autoType: "engagement_sent",
    text: `Sent: ${item.caption}`.slice(0, 500),
    authorId: actorId || null,
    at: new Date(),
  });
  lane.lastUpdateAt = new Date();
  await LeadLane.updateOne({ _id: lane._id }, { $set: { lastUpdateAt: lane.lastUpdateAt } });
  await EnquiryRepository.touchLastActivity(leadId);
  await LeadInternalEventService.record({
    leadId,
    type: "engagement_sent",
    actorId: actorId || null,
    payload: { laneId: String(lane._id), itemId: item.id, caption: item.caption },
  });
  return { entry: entry.toObject(), item: { id: item.id, caption: item.caption } };
};

// GET .../engagement-items — the ACTIVE library items, readable by the people
// who actually send them (lane owner / lead roster — gated at the controller).
// The settings-gated GET/PUT remains the EDIT surface.
const engagementItems = async (leadId, laneId) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }, { key: 1 }).lean();
  if (!lane) throw err(404, "Lane not found");
  if (lane.key !== "engagement") throw err(400, "engagement-items applies to the engagement lane only");
  const SettingsService = require("./SettingsService");
  const items = (await SettingsService.get("engagement.items")) || [];
  return items
    .filter((i) => i && i.active !== false)
    .map((i) => ({ id: i.id, caption: i.caption, tone: i.tone || "", imageUrl: i.imageUrl || "" }));
};

// GET .../engagement-log — the lane's sent items, newest first.
const engagementLog = async (leadId, laneId) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }, { key: 1 }).lean();
  if (!lane) throw err(404, "Lane not found");
  const rows = await LaneEntry.find(
    { laneId, autoType: "engagement_sent" },
    { text: 1, authorId: 1, at: 1 }
  )
    .sort({ at: -1 })
    .lean();
  return rows.map((r) => ({
    item: String(r.text || "").replace(/^Sent: /, ""),
    when: r.at,
    byId: r.authorId ? String(r.authorId) : null,
  }));
};


// C3 — NUDGE. Lane owner (or any current roster member / the lead owner)
// flags an Awaiting-client lane INTERNALLY: an auto lane entry + an
// AdminNotification to the LEAD OWNER (fallback: the owner's reporting
// manager, then Revenue Heads — the disqualify-notify ladder). NEVER touches
// the client-facing channels. Deduped: once per lane per 24h (409).
const nudge = async (leadId, laneId, actorId) => {
  if (!isId(leadId) || !isId(laneId)) throw err(400, "Invalid id");
  const lane = await LeadLane.findOne({ _id: laneId, leadId }).lean();
  if (!lane) throw err(404, "Lane not found");
  const Enquiry = require("../models/Enquiry");
  const lead = await Enquiry.findById(leadId, { name: 1, assignedTo: 1 }).lean();
  if (!lead) throw err(404, "Lead not found");

  // Actor must be the lane owner, the lead owner, or a current roster member.
  const { isCurrentRosterMember } = require("../utils/leadScope");
  const isLaneOwner = lane.ownerId && String(lane.ownerId) === String(actorId);
  const isLeadOwner = lead.assignedTo && String(lead.assignedTo) === String(actorId);
  if (!isLaneOwner && !isLeadOwner && !(await isCurrentRosterMember(leadId, actorId))) {
    throw err(403, "Only the lane owner or the lead's team can nudge.");
  }

  // Dedupe — one nudge per lane per 24h.
  const recent = await LaneEntry.findOne({
    laneId,
    kind: "auto",
    autoType: "nudge",
    at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  }).lean();
  if (recent) throw err(409, "Already nudged in the last 24h — give it a beat.");

  const waitingDays = Math.max(0, Math.floor((Date.now() - +new Date(lane.lastUpdateAt)) / (24 * 60 * 60 * 1000)));

  // Recipient ladder: lead owner → their reporting manager → Revenue Heads —
  // always filtered through the assignable predicate; actor never self-notified.
  const { filterAssignableIds } = require("../utils/assignable");
  const Admin = require("../models/Admin");
  let recipients = [];
  let flaggedToName = "the lead owner";
  if (lead.assignedTo) {
    recipients = await filterAssignableIds([lead.assignedTo]);
    if (recipients.length) {
      const ownerDoc = await Admin.findById(lead.assignedTo, { name: 1 }).lean();
      if (ownerDoc) flaggedToName = ownerDoc.name;
    }
  }
  if (!recipients.length && lead.assignedTo) {
    const ownerDoc = await Admin.findById(lead.assignedTo, { reportingManagerId: 1 }).lean();
    if (ownerDoc && ownerDoc.reportingManagerId) {
      recipients = await filterAssignableIds([ownerDoc.reportingManagerId]);
      if (recipients.length) flaggedToName = "the reporting manager";
    }
  }
  if (!recipients.length) {
    recipients = await filterAssignableIds(await require("./TriageService").revenueHeadIds());
    if (recipients.length) flaggedToName = "the Revenue Head";
  }
  recipients = recipients.filter((r) => String(r) !== String(actorId));

  const text = `Nudge: waiting on client ${waitingDays}d — flagged to ${flaggedToName}`;
  const entry = await LaneEntry.create({
    laneId,
    leadId,
    kind: "auto",
    text,
    authorId: actorId || null,
    autoType: "nudge",
    at: new Date(),
  });

  if (recipients.length) {
    await require("./AdminNotificationService").notify(recipients, {
      type: "lane_nudge",
      title: `${lane.name} on ${lead.name}: waiting on client ${waitingDays}d`,
      message: text,
      leadId,
      payload: { laneId: String(laneId), laneKey: lane.key, waitingDays, nudgedBy: String(actorId || "") },
    });
  }
  return { entry: entry.toObject(), waitingDays, notified: recipients.map(String) };
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
  proposePrice,
  confirmPrice,
  displayStatusOf,
  laneKeyForService,
  vendorNameFromKey,
  groupKeyFor,
  markEngagementSent,
  engagementLog,
  engagementItems,
  nudge,
};

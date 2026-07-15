// W5 — ESCALATIONS READ. Role-scoped list over the sweep's durable records:
// EscalationMark (one row per fired episode-rung — key
// `${kind}:${leadId}:${slot}:${rung}:${sinceEpoch}`) joined with lead / lane /
// spine state for OPENNESS, and AdminNotification rows for the notified trail
// (one doc per recipient — fully reconstructable).
//   kinds: lane | engagement (a lane whose key is "engagement") | deal |
//          snooze-wake (SnoozeService's warn marks, kind "snooze")
// Scope: manager → their team; RH/founder → all; ?scope honored DOWNWARD only.
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadLane = require("../models/LeadLane");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const { computeDealSpine, bulkSpineInputs } = require("./DealSpineService");

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 45; // how far back fired marks are considered
const MARK_CAP = 1000;

const STATION_LABEL = {
  qualified: "Qualified",
  meeting_set: "Meeting scheduled",
  meeting_held: "Meeting held",
  proposal: "Proposal sent",
  agreement: "Agreement & fee",
  onboarded: "Converted",
};

const TRAIL_TYPES = ["lane_silent", "deal_stalled", "lead_waking"];

// key = kind:leadId:slot:rung:sinceEpoch (slot never contains ":").
const parseKey = (key) => {
  const parts = String(key || "").split(":");
  if (parts.length < 5) return null;
  const [kind, leadId, slot, rung, sinceEpoch] = parts;
  return { kind, leadId, slot, rung: Number(rung), sinceEpoch: Number(sinceEpoch) };
};

// Resolve the effective scope filter. `reqScope`/`reqScopeFilter` come from
// requirePermission; founder/RH upgrade to all; ?scope=team downgrades an
// all-scope caller to their own team.
const resolveScope = async (callerId, reqScope, reqScopeFilter, requested) => {
  const { callerContext } = require("./RoleService");
  const { roleIdsOf, buildScopeFilter } = require("../middlewares/requirePermission");
  const Role = require("../models/Role");
  const { admin, isFounder } = await callerContext(callerId);
  const ids = roleIdsOf(admin);
  const roles = ids.length ? await Role.find({ _id: { $in: ids }, deletedAt: null }, { name: 1 }).lean() : [];
  const isRevenueHead = roles.some((r) => r.name === "Revenue Head");

  let effective = reqScope || "team";
  let filter = reqScopeFilter || {};
  if (isFounder || isRevenueHead) {
    effective = "all";
    filter = {};
  }
  if (requested === "team" && effective === "all") {
    effective = "team";
    filter = await buildScopeFilter("team", admin, "assignedTo");
  }
  return { scope: effective, filter };
};

const list = async ({ callerId, reqScope, reqScopeFilter, requestedScope, page = 1, limit = 20 }) => {
  const now = new Date();
  const { scope, filter } = await resolveScope(callerId, reqScope, reqScopeFilter, requestedScope);
  const windowStart = new Date(+now - WINDOW_DAYS * DAY_MS);

  // 1 · recent marks → episodes (max rung per kind:leadId:slot).
  const marks = await EscalationMark.find({ firedAt: { $gte: windowStart } })
    .sort({ firedAt: -1 })
    .limit(MARK_CAP)
    .lean();
  const episodes = new Map();
  for (const m of marks) {
    const k = parseKey(m.key);
    if (!k) continue;
    const epKey = `${k.kind}:${k.leadId}:${k.slot}`;
    const ep = episodes.get(epKey);
    if (!ep) {
      episodes.set(epKey, { ...k, firedAt: m.firedAt });
    } else {
      if (k.rung > ep.rung) ep.rung = k.rung;
      if (k.sinceEpoch < ep.sinceEpoch) ep.sinceEpoch = k.sinceEpoch;
      if (+m.firedAt > +ep.firedAt) ep.firedAt = m.firedAt;
    }
  }
  const eps = [...episodes.values()];
  if (!eps.length) return { items: [], total: 0, page, limit, scope };

  // 2 · scope + existence join on leads (batched).
  const leadIds = [...new Set(eps.map((e) => e.leadId))];
  const leads = await Enquiry.find(
    { $and: [{ _id: { $in: leadIds }, archivedAt: null }, filter] },
    {
      name: 1, assignedTo: 1, stage: 1, isLost: 1, lostStatus: 1, snoozedUntil: 1,
      qualified: 1, qualifiedAt: 1, followUps: 1, proposalSentAt: 1, agreementSentAt: 1,
    }
  ).lean();
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  // 3 · lane join for lane-kind episodes (slot = laneId).
  const laneIds = eps.filter((e) => e.kind === "lane").map((e) => e.slot);
  const lanes = laneIds.length
    ? await LeadLane.find({ _id: { $in: laneIds } }, { name: 1, key: 1, state: 1, lastUpdateAt: 1 }).lean()
    : [];
  const laneById = new Map(lanes.map((l) => [String(l._id), l]));

  // 4 · bulk spine for deal-kind episodes (openness = still stalled there).
  const dealLeadIds = [
    ...new Set(
      eps.filter((e) => e.kind === "deal" && leadById.has(e.leadId)).map((e) => e.leadId)
    ),
  ];
  const spineInputsByLead = await bulkSpineInputs(dealLeadIds);

  const terminal = (l) => l.stage === "won" || l.stage === "lost" || l.isLost === true || l.lostStatus === "approved";

  const open = [];
  for (const ep of eps) {
    const lead = leadById.get(ep.leadId);
    if (!lead) continue; // out of scope / archived
    if (ep.kind === "lane") {
      const lane = laneById.get(ep.slot);
      if (!lane || lane.state !== "active" || terminal(lead)) continue;
      // The episode is alive while its silence anchor hasn't moved.
      if (+new Date(lane.lastUpdateAt) !== ep.sinceEpoch) continue;
      const silentDays = Math.floor((+now - +new Date(lane.lastUpdateAt)) / DAY_MS);
      open.push({
        ep, lead,
        kind: lane.key === "engagement" ? "engagement" : "lane",
        laneName: lane.name,
        what: lane.key === "engagement" ? `Engagement pulse silent ${silentDays}d` : `${lane.name} lane silent ${silentDays}d`,
        since: new Date(ep.sinceEpoch),
      });
    } else if (ep.kind === "deal") {
      if (terminal(lead)) continue;
      const spine = computeDealSpine(lead, spineInputsByLead.get(ep.leadId));
      if (spine.current !== ep.slot) continue; // moved on — episode closed
      open.push({
        ep, lead,
        kind: "deal",
        laneName: null,
        what: `Deal stalled at ${STATION_LABEL[ep.slot] || ep.slot}`,
        since: new Date(ep.sinceEpoch),
      });
    } else if (ep.kind === "snooze") {
      if (terminal(lead) || !lead.snoozedUntil) continue; // woke already
      open.push({
        ep, lead,
        kind: "snooze-wake",
        laneName: null,
        what: `Parked lead waking ${new Date(lead.snoozedUntil).toDateString()}`,
        since: new Date(ep.sinceEpoch),
      });
    }
  }

  // 5 · notified trail — AdminNotification rows per recipient (batched).
  const openLeadIds = [...new Set(open.map((o) => String(o.lead._id)))];
  const notifs = openLeadIds.length
    ? await AdminNotification.find(
        { leadId: { $in: openLeadIds }, type: { $in: TRAIL_TYPES }, createdAt: { $gte: windowStart } },
        { adminId: 1, leadId: 1, type: 1, payload: 1, createdAt: 1 }
      ).sort({ createdAt: 1 }).lean()
    : [];
  const trailFor = (o) => {
    const wantType = o.kind === "deal" ? "deal_stalled" : o.kind === "snooze-wake" ? "lead_waking" : "lane_silent";
    return notifs.filter((n) => {
      if (String(n.leadId) !== String(o.lead._id) || n.type !== wantType) return false;
      if (wantType === "lane_silent") return String((n.payload || {}).laneId || "") === o.ep.slot;
      if (wantType === "deal_stalled") return String((n.payload || {}).station || "") === o.ep.slot || !(n.payload || {}).station;
      return true;
    });
  };

  // owner + recipient names in one batch.
  const adminIds = [
    ...new Set([
      ...open.map((o) => String(o.lead.assignedTo || "")).filter(Boolean),
      ...notifs.map((n) => String(n.adminId || "")).filter(Boolean),
    ]),
  ];
  const admins = adminIds.length ? await Admin.find({ _id: { $in: adminIds } }, { name: 1 }).lean() : [];
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));

  const items = open
    .map((o) => {
      const trailIds = [...new Set(trailFor(o).map((n) => String(n.adminId)))];
      return {
        leadId: String(o.lead._id),
        leadName: o.lead.name,
        kind: o.kind,
        what: o.what,
        laneName: o.laneName,
        ownerId: o.lead.assignedTo ? String(o.lead.assignedTo) : null,
        ownerName: o.lead.assignedTo ? nameOf.get(String(o.lead.assignedTo)) || "—" : null,
        rung: o.ep.rung,
        since: o.since,
        notifiedTrail: trailIds.length ? trailIds.map((id) => nameOf.get(id) || "—") : null,
      };
    })
    .sort((a, b) => (b.rung !== a.rung ? b.rung - a.rung : +new Date(b.since) - +new Date(a.since)));

  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  return {
    items: items.slice((p - 1) * l, p * l),
    total: items.length,
    page: p,
    limit: l,
    scope,
  };
};

module.exports = { list, WINDOW_DAYS };

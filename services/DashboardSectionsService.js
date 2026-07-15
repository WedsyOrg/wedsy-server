// W4 — DASHBOARD WORKSPACE SECTIONS (additive to DashboardService's payload;
// nothing existing is dropped or reshaped).
//   valueStrip                 — RH/founder only: Σ dealValue.amount at the
//                                proposal / agreement stations + won this IST
//                                month. null for everyone else.
//   escalationsTop             — the 3 most severe OPEN escalations in scope
//                                (composed by EscalationReadService).
//   awaitingHumanQualification — needsHumanQualification leads in scope
//                                (channel/since joined from WAConversation —
//                                the Enquiry flag itself is a bare boolean).
//   wins                       — last 5 won in scope. NO amounts.
//   rescue                     — the existing snooze-aware rescue read,
//                                exposed for manager+ (replaces the Rescue tab).
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const WAConversation = require("../models/WAConversation");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const RescueService = require("./RescueService");
const EscalationReadService = require("./EscalationReadService");
const { computeDealSpine, bulkSpineInputs } = require("./DealSpineService");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const { sourceChannelOf } = require("../utils/leadSource");
const { toIstWallClock, fromIstParts } = require("../utils/goldenWindow");

const ACTIVE = {
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
  lostStatus: { $nin: ["pending", "approved"] },
  archivedAt: null,
};

const istMonthStart = (now) => {
  const ist = toIstWallClock(now);
  return fromIstParts(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0);
};

const buildWorkspaceSections = async (adminId, scope, scopeFilter = {}) => {
  const now = new Date();
  const visibility = await currentVisibilityFilter();

  const { callerContext } = require("./RoleService");
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const { admin, isFounder } = await callerContext(adminId);
  const roles = admin && roleIdsOf(admin).length
    ? await Role.find({ _id: { $in: roleIdsOf(admin) }, deletedAt: null }, { name: 1 }).lean()
    : [];
  const isRevenueHead = roles.some((r) => r.name === "Revenue Head");

  const sections = {};

  // ── wins + won-this-month (shared batch) ──
  const wonDocs = await Enquiry.find(
    { $and: [{ stage: "won" }, scopeFilter, visibility] },
    { name: 1, assignedTo: 1, updatedAt: 1, dealValue: 1 }
  )
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();
  const wonIds = wonDocs.map((l) => l._id);
  const wonEvents = wonIds.length
    ? await LeadInternalEvent.find(
        { leadId: { $in: wonIds }, type: "client_onboarded" },
        { leadId: 1, createdAt: 1 }
      ).lean()
    : [];
  const wonAtByLead = new Map();
  for (const e of wonEvents) {
    const key = String(e.leadId);
    if (!wonAtByLead.has(key) || +e.createdAt < +wonAtByLead.get(key)) wonAtByLead.set(key, e.createdAt);
  }
  const wonAtOf = (l) => wonAtByLead.get(String(l._id)) || l.updatedAt;

  const winOwnerIds = [...new Set(wonDocs.map((l) => String(l.assignedTo || "")).filter(Boolean))];
  const winOwners = winOwnerIds.length
    ? await Admin.find({ _id: { $in: winOwnerIds } }, { name: 1 }).lean()
    : [];
  const ownerName = new Map(winOwners.map((a) => [String(a._id), a.name]));

  sections.wins = [...wonDocs]
    .sort((a, b) => +new Date(wonAtOf(b)) - +new Date(wonAtOf(a)))
    .slice(0, 5)
    .map((l) => ({
      leadId: String(l._id),
      name: l.name,
      wonAt: wonAtOf(l),
      ownerName: l.assignedTo ? ownerName.get(String(l.assignedTo)) || "—" : null,
      // deliberately NO amounts here
    }));

  // ── valueStrip (RH/founder only) ──
  if (isFounder || isRevenueHead) {
    const qualLeads = await Enquiry.find(
      { $and: [{ qualified: true, ...ACTIVE }, scopeFilter, visibility] },
      { qualified: 1, qualifiedAt: 1, followUps: 1, stage: 1, proposalSentAt: 1, agreementSentAt: 1, dealValue: 1 }
    ).lean();
    const inputs = await bulkSpineInputs(qualLeads.map((l) => l._id));
    let proposal = 0;
    let agreement = 0;
    for (const l of qualLeads) {
      const spine = computeDealSpine(l, inputs.get(String(l._id)));
      let reached = "qualified";
      for (const s of spine.stations) {
        if (s.key === "onboarded") break;
        if (s.done) reached = s.key;
      }
      const amt = (l.dealValue && l.dealValue.amount) || 0;
      if (reached === "proposal") proposal += amt;
      else if (reached === "agreement") agreement += amt;
    }
    const monthStart = istMonthStart(now);
    const onboardedThisMonth = wonDocs
      .filter((l) => +new Date(wonAtOf(l)) >= +monthStart)
      .reduce((sum, l) => sum + ((l.dealValue && l.dealValue.amount) || 0), 0);
    sections.valueStrip = { proposal, agreement, onboardedThisMonth };
  } else {
    sections.valueStrip = null;
  }

  // ── escalationsTop — the 3 most severe open, caller-scoped ──
  const esc = await EscalationReadService.list({
    callerId: adminId,
    reqScope: scope,
    reqScopeFilter: scopeFilter,
    requestedScope: null,
    page: 1,
    limit: 3,
  });
  sections.escalationsTop = esc.items.map(({ leadId, leadName, what, ownerName: on, since, rung }) => ({
    leadId, leadName, what, ownerName: on, since, rung,
  }));

  // ── awaitingHumanQualification ──
  const nhDocs = await Enquiry.find(
    { $and: [{ needsHumanQualification: true, ...ACTIVE }, scopeFilter, visibility] },
    { name: 1, source: 1, marketingSource: 1, createdAt: 1 }
  )
    .sort({ createdAt: -1 })
    .lean();
  const nhIds = nhDocs.map((l) => l._id);
  const convs = nhIds.length
    ? await WAConversation.find(
        { enquiryId: { $in: nhIds } },
        { enquiryId: 1, channel: 1, needsHumanAt: 1 }
      ).lean()
    : [];
  const convByLead = new Map();
  for (const c of convs) {
    const key = String(c.enquiryId);
    if (!convByLead.has(key) || (c.needsHumanAt && !convByLead.get(key).needsHumanAt)) convByLead.set(key, c);
  }
  sections.awaitingHumanQualification = {
    count: nhDocs.length,
    rows: nhDocs.slice(0, 20).map((l) => {
      const c = convByLead.get(String(l._id));
      return {
        leadId: String(l._id),
        name: l.name,
        channel: (c && c.channel) || sourceChannelOf(l.source, l.marketingSource),
        since: (c && c.needsHumanAt) || null,
      };
    }),
  };

  // ── rescue — the existing snooze-aware read, manager+ only ──
  sections.rescue = scope !== "own" ? await RescueService.rescueQueue(adminId, scope) : null;

  return sections;
};

module.exports = { buildWorkspaceSections };

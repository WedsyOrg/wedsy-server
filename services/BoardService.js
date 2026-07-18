// W3 — BOARD BY STATION. One caller-scoped pass over the leads, columns keyed:
// new · working · qualified · meeting_set · meeting_held · proposal ·
// agreement · onboarded · lost.
//   pre-qual  → new (no firstRespondedAt) / working (responded, unqualified)
//   qualified → placed by the deal-spine's CURRENT station (bulk-computed —
//               four batched queries total, never per-lead)
//   lost      → stage/lost facts;   won → onboarded
// Value per column = Σ dealValue.amount, MANAGER+ ONLY (null for own-scope).
// Interns (assignment.poolRoles) get ONLY new/working/qualified/lost.
const Enquiry = require("../models/Enquiry");
const Role = require("../models/Role");
const CommitmentService = require("./CommitmentService");
const SettingsService = require("./SettingsService");
const { computeDealSpine, bulkSpineInputs } = require("./DealSpineService");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const { sourceChannelOf } = require("../utils/leadSource");
const { bucketOf, temperatureCutoffs, temperatureOf, temperatureLabelOf } = require("../utils/leadLifecycle");
const { isTerminalLost } = require("../utils/lostTerminal");

const COLUMN_KEYS = ["new", "working", "qualified", "meeting_set", "meeting_held", "proposal", "agreement", "onboarded", "lost"];
const INTERN_COLUMN_KEYS = ["new", "working", "qualified", "lost"];
const MAX_ROWS_PER_COLUMN = 100; // count/value cover the WHOLE column; rows cap

// Fields the FE list-row shape reads — everything except the heavy transcript
// arrays. followUps rides along because rowMarks and the spine both need it.
const PROJECTION = { callLog: 0, conversations: 0, notes: 0 };

// Lost is terminal — the shared predicate (pending-approval leads stay in
// their live column; the lost COLUMN itself keeps terminal leads).
const isLostLead = (l) => isTerminalLost(l);

// Intern = the caller's role name is in the assignment.poolRoles settings list
// (the same definition TriageService/InternMetrics use).
const isInternCaller = async (callerId) => {
  const Admin = require("../models/Admin");
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const [admin, poolRoles] = await Promise.all([
    Admin.findById(callerId).lean(),
    SettingsService.get("assignment.poolRoles"),
  ]);
  const ids = roleIdsOf(admin);
  if (!ids.length) return false;
  const roles = await Role.find({ _id: { $in: ids }, deletedAt: null }, { name: 1 }).lean();
  const pool = new Set((poolRoles || []).map(String));
  return roles.some((r) => pool.has(r.name));
};

const board = async (callerId, scope, scopeFilter = {}, opts = {}) => {
  const now = new Date();
  const visibility = await currentVisibilityFilter();
  // C1 — participant scope always ships the FULL column set (worked post-qual
  // leads); the intern collapse applies only to the default board.
  const intern = opts.fullColumns ? false : await isInternCaller(callerId);
  const columnKeys = intern ? INTERN_COLUMN_KEYS : COLUMN_KEYS;

  // One pass over the caller-scoped leads (won + lost included — they have
  // columns here, unlike the active-only dashboard queues).
  const leads = await Enquiry.find(
    {
      $and: [
        scopeFilter,
        visibility,
        { archivedAt: null, "recycled.isRecycled": { $ne: true } },
      ],
    },
    PROJECTION
  )
    .sort({ createdAt: -1 })
    .lean();

  // Bulk spine for the qualified, still-in-play leads — 4 queries total.
  const spineLeads = intern
    ? []
    : leads.filter((l) => l.qualified === true && l.stage !== "won" && !isLostLead(l));
  const spineInputsByLead = await bulkSpineInputs(spineLeads.map((l) => l._id));

  const columnOf = (l) => {
    if (isLostLead(l)) return "lost";
    if (intern) return l.qualified === true || l.stage === "won" ? "qualified" : l.firstRespondedAt ? "working" : "new";
    if (l.stage === "won") return "onboarded";
    if (l.qualified === true) {
      // The station the deal has REACHED — the furthest DONE spine station.
      // (spine.current is the NEXT milestone: a fresh qual's current is already
      // meeting_set, which would leave the qualified column empty and promote
      // agreement-done deals to onboarded before they are won.)
      const spine = computeDealSpine(l, spineInputsByLead.get(String(l._id)));
      let reached = "qualified";
      for (const s of spine.stations) {
        if (s.key === "onboarded") break; // stage "won" owns that column
        if (s.done) reached = s.key;
      }
      return reached;
    }
    return l.firstRespondedAt ? "working" : "new";
  };

  const columns = Object.fromEntries(columnKeys.map((k) => [k, { count: 0, value: scope !== "own" ? 0 : null, leads: [] }]));

  const placed = [];
  for (const l of leads) {
    const key = columnOf(l);
    if (!columns[key]) continue; // intern: stations beyond their column set never occur (qualified swallows them)
    placed.push({ lead: l, key });
  }

  // Row marks (dueToday/overdue) — batched: two queries for the whole board,
  // computed only for the rows that will actually ship (the per-column cap).
  const shipping = [];
  for (const { lead, key } of placed) {
    const col = columns[key];
    col.count += 1;
    if (scope !== "own" && lead.dealValue && lead.dealValue.amount != null) {
      col.value += lead.dealValue.amount;
    }
    if (col.leads.length < MAX_ROWS_PER_COLUMN) {
      col.leads.push(lead);
      shipping.push(lead);
    }
  }
  const marks = await CommitmentService.rowMarks(shipping, { scope, callerId });

  // Decorate shipped rows exactly like the list endpoint (GetAll parity).
  const cutoffs = temperatureCutoffs(now);
  for (const col of Object.values(columns)) {
    col.leads = col.leads.map((o) => {
      const rm = marks.get(String(o._id)) || { dueToday: 0, overdue: 0 };
      return {
        ...o,
        lifecycle: bucketOf(o, cutoffs.today),
        temperature: temperatureOf(o.qualificationData && o.qualificationData.eventDate, cutoffs),
        temperatureLabel: temperatureLabelOf(o.qualificationData && o.qualificationData.eventDate, cutoffs),
        sourceChannel: sourceChannelOf(o.source, o.marketingSource),
        dealValue:
          scope && scope !== "own" && o.dealValue && o.dealValue.amount != null
            ? { amount: o.dealValue.amount }
            : null,
        dueToday: rm.dueToday,
        overdue: rm.overdue,
      };
    });
  }

  return { columns, columnKeys, scope, intern, generatedAt: now };
};

module.exports = { board, COLUMN_KEYS, INTERN_COLUMN_KEYS, isInternCaller };

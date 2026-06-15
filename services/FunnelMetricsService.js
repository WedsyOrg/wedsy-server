const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadStep = require("../models/LeadStep");
const Onboarding = require("../models/Onboarding");
const GoldenWindowService = require("./GoldenWindowService");

const idStr = (v) => String(v);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

// MB9b — the role dashboards' shared aggregation. ONE cohort (leads received in
// the period, in the caller's scope) is tracked through every funnel stage, so
// each stage is a strict subset of `received` and the numbers always reconcile.
// The funnel SPLITS at qualification: the INTAKE half (received → contacted →
// qualified) and the CONVERSION half (qualified → in-journey → onboarded / lost).
// Golden-window is REUSED verbatim from GoldenWindowService.metrics (not
// recomputed differently). Scope is the caller's existing lead scope — no new RBAC.

const periodDaysOf = (period) => (period === "month" ? 30 : 7);

// Per-cohort intake + conversion aggregate (pure over the loaded data).
const aggregate = (leads, stepLeadSet, onboardedSet, lostSet, feeByLead) => {
  let received = 0, contacted = 0, qualified = 0, inJourney = 0, onboarded = 0, lost = 0, fees = 0;
  for (const l of leads) {
    received += 1;
    if (l.firstCalledAt) contacted += 1;
    const isLost = lostSet.has(idStr(l._id));
    const isOnboarded = onboardedSet.has(idStr(l._id));
    if (l.qualified) {
      qualified += 1;
      if (!isOnboarded && !isLost && stepLeadSet.has(idStr(l._id))) inJourney += 1;
    }
    if (isOnboarded) { onboarded += 1; fees += feeByLead.get(idStr(l._id)) || 0; }
    if (isLost) lost += 1;
  }
  return {
    intake: { received, contacted, qualified, qualRatePct: pct(qualified, received) },
    conversion: { qualified, inJourney, onboarded, lost, onboardRatePct: pct(onboarded, qualified), feesCollected: fees },
  };
};

// Golden-window for a set of leads, computed with the SAME clockFor as
// GoldenWindowService.metrics (so per-person numbers reconcile with the headline).
const goldenWindowFor = (leads, hm, t, now) => {
  let decided = 0, inWindow = 0, breaches = 0, respSum = 0, respN = 0;
  for (const l of leads) {
    const c = GoldenWindowService.clockFor(l, hm.get(idStr(l._id)), t, now);
    if (!(c.contactedAt != null || c.state === "breached")) continue;
    decided += 1;
    if (c.inWindow) inWindow += 1;
    if (c.breached) breaches += 1;
    if (c.contactedAt) { respSum += (+new Date(c.contactedAt) - +new Date(c.startAt)) / MIN; respN += 1; }
  }
  return {
    total: decided,
    inWindowPct: decided ? Math.round((inWindow / decided) * 100) : null,
    avgFirstResponseMinutes: respN ? Math.round(respSum / respN) : null,
    breachCount: breaches,
  };
};

const funnel = async (adminId, scope, { period = "week" } = {}, now = new Date()) => {
  const periodDays = periodDaysOf(period);
  const since = new Date(+now - periodDays * DAY);
  const owners = await GoldenWindowService.ownerScopeIds(adminId, scope); // null = all

  const leadFilter = { createdAt: { $gte: since } };
  if (owners) leadFilter.assignedTo = { $in: owners.map((o) => new mongoose.Types.ObjectId(idStr(o))) };
  const leads = await Enquiry.find(leadFilter, {
    assignedTo: 1, createdAt: 1, firstCalledAt: 1, qualified: 1, isLost: 1, lostStatus: 1, recycled: 1, name: 1,
  }).lean();
  const leadIds = leads.map((l) => l._id);

  // Batch the conversion-stage signals for the cohort.
  const [stepLeadIds, onboardings, t, hm] = await Promise.all([
    LeadStep.distinct("leadId", { leadId: { $in: leadIds } }),
    Onboarding.find({ leadId: { $in: leadIds } }, { leadId: 1, status: 1, milestones: 1 }).lean(),
    GoldenWindowService.thresholds(),
    GoldenWindowService.handoffMap(leadIds),
  ]);
  const stepLeadSet = new Set(stepLeadIds.map(idStr));
  const onboardedSet = new Set();
  const feeByLead = new Map();
  for (const o of onboardings) {
    if (o.status === "onboarded") {
      onboardedSet.add(idStr(o.leadId));
      // Fees collected = the onboarding-fee that landed to mark onboarded
      // (graceful: 0 when the milestone snapshot is absent).
      const fee = o.milestones && Number(o.milestones.onboardingFee);
      feeByLead.set(idStr(o.leadId), Number.isFinite(fee) ? fee : 0);
    }
  }
  const lostSet = new Set(leads.filter((l) => l.isLost || l.lostStatus === "approved").map((l) => idStr(l._id)));

  const overall = aggregate(leads, stepLeadSet, onboardedSet, lostSet, feeByLead);
  // REUSE the canonical golden-window metric for the headline (reconciles with
  // /golden-window/metrics + Respond-now).
  const goldenWindow = await GoldenWindowService.metrics(adminId, scope, { periodDays }, now);

  // Per-person breakdown for a team / all view (the RevHead + sales-lead comparison).
  let perPerson = null;
  if (scope === "team" || scope === "department" || scope === "all") {
    const byPerson = new Map();
    for (const l of leads) {
      const k = l.assignedTo ? idStr(l.assignedTo) : "unassigned";
      if (!byPerson.has(k)) byPerson.set(k, []);
      byPerson.get(k).push(l);
    }
    const ids = [...byPerson.keys()].filter((k) => k !== "unassigned");
    const admins = ids.length ? await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean() : [];
    const nameOf = new Map(admins.map((a) => [idStr(a._id), a.name]));
    perPerson = [...byPerson.entries()].map(([k, pl]) => {
      const agg = aggregate(pl, stepLeadSet, onboardedSet, lostSet, feeByLead);
      return {
        _id: k === "unassigned" ? null : k,
        name: k === "unassigned" ? "Unassigned" : nameOf.get(k) || "—",
        intake: agg.intake,
        conversion: agg.conversion,
        goldenWindow: goldenWindowFor(pl, hm, t, now),
      };
    }).sort((a, b) => (b.intake.received) - (a.intake.received));
  }

  return {
    period,
    periodDays,
    scope,
    intake: overall.intake,
    conversion: overall.conversion,
    goldenWindow, // reused from GoldenWindowService.metrics
    perPerson,
  };
};

module.exports = { funnel, aggregate, goldenWindowFor, periodDaysOf };

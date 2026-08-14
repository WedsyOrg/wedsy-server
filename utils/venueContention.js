/**
 * utils/venueContention.js — BUILD3 S1. "Who else wants this date?"
 *
 * The one place date contention is computed, so the lead read and the day
 * endpoint can never disagree about the same date.
 *
 * ── SCOPING, deliberately ────────────────────────────────────────────────
 * This is the one place in the CRM where an AGGREGATE is computed OUTSIDE
 * utils/venueLeadScope, and it is a considered widening, not an oversight.
 *
 * The demand map (controllers/venueCrmDates.js) feeds its aggregate through
 * scopedLeadFilter, so a Sales member without leads_view_all sees contention
 * only among their OWN leads — which is to say, none. That is the safe default
 * for a browsing surface. It is the wrong default here: the entire value of
 * this feature is telling the person negotiating couple A that couple B wants
 * the same date and is further along, and couple B is, by definition, usually
 * somebody else's lead. Scoping the count would leave the feature working only
 * for the people who least need it.
 *
 * So the split is:
 *   COUNT and STAGE   — computed venue-wide. Aggregate, no PII: "4 other
 *                       enquiries want 26 Nov, one in negotiation."
 *   NAMES, IDS, MONEY — never leave the requester's scope. A scoped member
 *                       gets rows only for leads they could already open, and
 *                       `hiddenCount` for the rest, so the number they are told
 *                       still adds up without naming anyone.
 *
 * The residual leak is that a member can learn how many enquiries exist for a
 * date. That is the same order of information as the venue's public
 * availability, and it is the thing they need to do their job.
 *
 * Terminal (booked/lost) and soft-deleted leads are excluded everywhere: a lost
 * lead is not competition, and a booked one is reported through the booking
 * state instead of as an "enquiry that wants" the date.
 */
const VenueEnquiry = require("../models/VenueEnquiry");
const { venueDateKey, venueDayStartFromKey, addVenueDays } = require("./venueTime");

// Stage order for "furthest along". Terminal stages are never ranked because
// they are filtered out before we get here.
const STAGE_ORDER = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating"];
const stageRank = (s) => {
  const i = STAGE_ORDER.indexOf(s);
  return i === -1 ? -1 : i;
};
const TERMINAL = ["booked", "lost"];

/** The venue-calendar days a lead occupies. [] when it has no finalised dates. */
function leadDays(lead) {
  if (!lead || !lead.checkIn) return [];
  const first = venueDateKey(lead.checkIn);
  const last = lead.checkOut ? venueDateKey(lead.checkOut) : first;
  const out = [];
  let cursor = venueDayStartFromKey(first);
  // The window is capped at 7 days by the model; 9 is an unreachable backstop.
  for (let i = 0; i < 9; i += 1) {
    const key = venueDateKey(cursor);
    out.push(key);
    if (key >= last) break;
    cursor = addVenueDays(cursor, 1);
  }
  return out;
}

/** "2026-11" for a day key or a {month,year} period. */
function monthKeyOfDay(dayKey) {
  return dayKey ? dayKey.slice(0, 7) : "";
}
function monthKeyOfPeriod(p) {
  return p && p.month && p.year ? `${p.year}-${String(p.month).padStart(2, "0")}` : "";
}

/**
 * Every non-terminal, non-deleted lead of this venue that occupies any of
 * `dayKeys`. VENUE-WIDE by design (see the header). `excludeId` drops the lead
 * we are reporting for.
 *
 * Bounded query: a window is at most 7 days, so anything overlapping our range
 * must start within 7 days before the last day we care about.
 */
async function leadsOnDays(venueId, dayKeys, excludeId) {
  if (!dayKeys || !dayKeys.length) return [];
  const sorted = [...dayKeys].sort();
  const lo = addVenueDays(venueDayStartFromKey(sorted[0]), -8);
  const hi = addVenueDays(venueDayStartFromKey(sorted[sorted.length - 1]), 1);
  const filter = {
    venueId,
    deleted: { $ne: true },
    stage: { $nin: TERMINAL },
    checkIn: { $gte: lo, $lt: hi },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const rows = await VenueEnquiry.find(filter)
    .select("coupleName name checkIn checkOut stage estimatedValue assignedTo")
    .lean();
  const want = new Set(dayKeys);
  return rows.filter((r) => leadDays(r).some((d) => want.has(d)));
}

/**
 * Per-day contention over `dayKeys`, plus the worst day.
 *
 * MULTI-DAY: a 30 Sep → 1 Oct block contends on BOTH days, and the headline is
 * the WORST day, not the sum. Two reasons. First, losing any single day of a
 * multi-day block usually kills the whole block — the venue cannot sell 30 Sep
 * to someone else and still host a 30 Sep → 1 Oct wedding — so the risk to this
 * lead is set by its most contested day, not by an average or a total. Second,
 * the headline names a date and links to that date's day view; reporting a
 * summed count while linking to a day that shows fewer rows would be
 * incoherent. `days` carries the full breakdown for anything that wants it, and
 * `totalLeads` the distinct count across the whole block.
 */
function summarise(dayKeys, rows) {
  const byDay = new Map(dayKeys.map((d) => [d, []]));
  for (const r of rows) {
    for (const d of leadDays(r)) if (byDay.has(d)) byDay.get(d).push(r);
  }
  const days = [...byDay.entries()]
    .map(([date, list]) => {
      let top = null;
      for (const l of list) if (stageRank(l.stage) > stageRank(top)) top = l.stage;
      return { date, count: list.length, topStage: top };
    })
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count || stageRank(b.topStage) - stageRank(a.topStage) || a.date.localeCompare(b.date));

  const worst = days[0] || null;
  const distinct = new Set(rows.map((r) => String(r._id)));
  return {
    count: worst ? worst.count : 0,
    topStage: worst ? worst.topStage : null,
    date: worst ? worst.date : null,
    days,
    totalLeads: distinct.size,
  };
}

/** The lead-read summary. Aggregate only — never names. */
async function contentionForLead(venueId, lead) {
  const dayKeys = leadDays(lead);
  if (!dayKeys.length) return null;
  const rows = await leadsOnDays(venueId, dayKeys, lead._id);
  const summary = summarise(dayKeys, rows);
  return summary.count > 0 ? summary : null;
}

/**
 * Unfinalised leads naming a month — the BUILD2 signal, surfaced here as its
 * own number. Never folded into contention: nobody is competing for a day that
 * nobody has named.
 */
async function approximateMonthDemand(venueId, monthKey, excludeId) {
  if (!monthKey) return 0;
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return 0;
  const filter = {
    venueId,
    deleted: { $ne: true },
    stage: { $nin: TERMINAL },
    datesFinalised: false,
    "approximatePeriod.year": year,
    "approximatePeriod.month": month,
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return VenueEnquiry.countDocuments(filter);
}

module.exports = {
  STAGE_ORDER,
  stageRank,
  leadDays,
  monthKeyOfDay,
  monthKeyOfPeriod,
  leadsOnDays,
  summarise,
  contentionForLead,
  approximateMonthDemand,
};

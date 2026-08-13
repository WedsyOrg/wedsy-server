/**
 * controllers/venueCrmDashboard.js — MB-CRM S4 dashboard overview.
 *
 * Everything here is computed from REAL data and honestly scoped by
 * leads_view_all (a member without it sees only their own leads). The Proof
 * card is the emotional payload and must never be fabricated:
 *   - "went cold" = a gap of >= 7 days with no logged interaction
 *   - "revived"   = a quick-log interaction (call/whatsapp/site_visit/note)
 *                   AFTER that gap
 *   - "saved"     = the lead later reached stage "booked"
 * No saves ⇒ an explicit empty flag so the UI shows an honest empty state,
 * never a zero-value stat.
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTask = require("../models/VenueTask");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const VenueFollowUp = require("../models/VenueFollowUp");
const { canViewAllLeads, scopedLeadFilter } = require("../utils/venueLeadScope");
const { resolveActorMemberId, resolveActorIds } = require("../utils/venueOwnerMember");
const { venueDayBounds } = require("../utils/venueTime");

const DAY = 24 * 60 * 60 * 1000;
const COLD_GAP_MS = 7 * DAY;
const REVIVAL_TYPES = new Set(["call", "whatsapp", "site_visit", "note"]);
const TERMINAL = new Set(["booked", "lost"]);

// "Today" is the venue's calendar day (IST), not the server's. On a UTC box
// server-local bounds mis-bucket every follow-up between 00:00 and 05:30 IST.
function dayBounds() {
  return venueDayBounds();
}
const leadName = (l) => l.coupleName || l.name || "Lead";

// GET /venues/:slug/crm/overview
const getCrmOverview = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const canViewAll = await canViewAllLeads(req.venueOwner, req.venueMember);
    // "Me" in the member-id space — the owner's own member row for an owner
    // token, so the my-day card counts what is actually assigned to them
    // instead of silently counting nothing.
    const memberId = await resolveActorMemberId(req);
    const actorIds = await resolveActorIds(req);

    // Scoped + soft-delete-excluded via the shared boundary.
    const leadFilter = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id);
    const leads = await VenueEnquiry.find(leadFilter)
      .select("coupleName name stage assignedTo followUpDate estimatedValue source createdAt updatedAt")
      .lean();

    const { start, end } = dayBounds();
    const nonTerminal = leads.filter((l) => !TERMINAL.has(l.stage));

    // ── my-day + alerts (all real counts) ──
    // overdue/dueToday are counted from the follow-up ROWS, not from the lead's
    // next-touch mirror: a lead can carry several open follow-ups, and the
    // mirror only shows the earliest. Counting rows is what makes this card
    // agree with the Follow-ups list it drills into (invariant #7).
    const nonTerminalIds = nonTerminal.map((l) => l._id);
    let overdue = 0, dueToday = 0;
    let legacyMirrorOnly = 0;
    if (nonTerminalIds.length) {
      const [rowOverdue, rowToday, leadsWithRows] = await Promise.all([
        VenueFollowUp.countDocuments({ venue: venue._id, lead: { $in: nonTerminalIds }, status: "open", dueAt: { $lt: start } }),
        VenueFollowUp.countDocuments({ venue: venue._id, lead: { $in: nonTerminalIds }, status: "open", dueAt: { $gte: start, $lte: end } }),
        VenueFollowUp.distinct("lead", { venue: venue._id, lead: { $in: nonTerminalIds } }),
      ]);
      overdue = rowOverdue;
      dueToday = rowToday;

      // Safety net for the deploy window before scripts/migrate-followups-module
      // has run: a lead that has NO follow-up rows at all still counts through
      // its legacy mirror. A lead either has rows or it doesn't, so this can
      // never double-count, and after the migration it is dead weight costing
      // one distinct(). Erring toward showing work that exists rather than
      // hiding it is the safe direction for a my-day card.
      const withRows = new Set(leadsWithRows.map(String));
      for (const l of nonTerminal) {
        if (withRows.has(String(l._id)) || !l.followUpDate) continue;
        legacyMirrorOnly++;
        const d = new Date(l.followUpDate);
        if (d < start) overdue++;
        else if (d >= start && d <= end) dueToday++;
      }
    }

    let noFollowUp = 0, unassigned = 0;
    let todaySiteVisit = null;
    for (const l of nonTerminal) {
      const fu = l.followUpDate ? new Date(l.followUpDate) : null;
      // The mirror is exactly the right source for "has no next step": it is
      // null precisely when the lead has no open follow-up.
      if (!fu) noFollowUp++;
      if (!l.assignedTo) unassigned++;
      if (l.stage === "site_visit_scheduled" && fu && fu >= start && fu <= end && !todaySiteVisit) {
        todaySiteVisit = { _id: l._id, name: leadName(l), estimatedValue: l.estimatedValue || 0 };
      }
    }

    // my open tasks due by end of today. createdBy holds an ACTOR id, which for
    // an owner is their venueOwnerId on every task written before the owner
    // member row existed — so both ids are matched (see resolveActorIds).
    const taskOr = [];
    if (memberId) taskOr.push({ assignedTo: memberId });
    if (actorIds.length) taskOr.push({ createdBy: { $in: actorIds } });
    // An empty $or is a Mongo error, so an unresolvable identity counts zero.
    const myTasksOpen = taskOr.length
      ? await VenueTask.countDocuments({
          venue: venue._id,
          status: "open",
          dueAt: { $lte: end },
          $or: taskOr,
        })
      : 0;

    // ── pipeline health ──
    const stageCounts = {};
    let inPipelineValue = 0;
    const sourceCounts = {};
    let bookedCount = 0;
    for (const l of leads) {
      stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1;
      if (l.source) sourceCounts[l.source] = (sourceCounts[l.source] || 0) + 1;
      if (l.stage === "booked") bookedCount++;
      if (!TERMINAL.has(l.stage)) inPipelineValue += l.estimatedValue || 0;
    }
    const topSource = Object.keys(sourceCounts).sort((a, b) => sourceCounts[b] - sourceCounts[a])[0] || null;
    const conversionPct = leads.length ? Math.round((bookedCount / leads.length) * 100) : null;

    // ── THE PROOF (honest, from interaction history) ──
    const bookedLeads = leads.filter((l) => l.stage === "booked");
    const proofSaves = [];
    if (bookedLeads.length) {
      const bookedIds = bookedLeads.map((l) => l._id);
      const interactions = await VenueLeadInteraction.find({ venue: venue._id, enquiry: { $in: bookedIds } })
        .select("enquiry type createdAt")
        .sort({ createdAt: 1 })
        .lean();
      const byLead = new Map();
      for (const it of interactions) {
        const k = String(it.enquiry);
        if (!byLead.has(k)) byLead.set(k, []);
        byLead.get(k).push(it);
      }
      for (const l of bookedLeads) {
        const hist = byLead.get(String(l._id)) || [];
        let maxColdDays = 0;
        for (let i = 1; i < hist.length; i++) {
          const gap = new Date(hist[i].createdAt) - new Date(hist[i - 1].createdAt);
          if (gap >= COLD_GAP_MS && REVIVAL_TYPES.has(hist[i].type)) {
            maxColdDays = Math.max(maxColdDays, Math.round(gap / DAY));
          }
        }
        if (maxColdDays > 0) {
          proofSaves.push({
            _id: l._id,
            name: leadName(l),
            coldDays: maxColdDays,
            value: l.estimatedValue || 0,
            bookedAt: l.updatedAt,
          });
        }
      }
    }
    proofSaves.sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt));
    const proof = {
      empty: proofSaves.length === 0,
      count: proofSaves.length,
      revivedValue: proofSaves.reduce((s, x) => s + x.value, 0),
      latest: proofSaves[0] || null,
    };

    return res.status(200).json({
      scoped: !canViewAll,
      myDay: { overdue, dueToday, noFollowUp, unassigned, myTasksOpen, todaySiteVisit },
      // Non-zero only until the follow-ups migration has run: leads still
      // counted via their legacy mirror because they own no follow-up rows.
      // A deploy-window observability signal, not a product number.
      legacyMirrorOnly,
      pipeline: {
        stageCounts,
        total: leads.length,
        activeTotal: nonTerminal.length,
        inPipelineValue,
        conversionPct,
        topSource,
      },
      proof,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getCrmOverview };

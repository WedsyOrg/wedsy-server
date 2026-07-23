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
const { hasCapability } = require("../utils/venueRbac");

const DAY = 24 * 60 * 60 * 1000;
const COLD_GAP_MS = 7 * DAY;
const REVIVAL_TYPES = new Set(["call", "whatsapp", "site_visit", "note"]);
const TERMINAL = new Set(["booked", "lost"]);

function dayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY - 1);
  return { start, end };
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

    const canViewAll = await hasCapability(req.venueOwner, "leads_view_all", req.venueMember);
    const memberId = req.venueOwner.memberId || null;
    const actorId = memberId || req.venueOwner.venueOwnerId || null;

    const leadFilter = { venueId: venue._id };
    if (!canViewAll) leadFilter.assignedTo = memberId; // scoped: only my leads

    const leads = await VenueEnquiry.find(leadFilter)
      .select("coupleName name stage assignedTo followUpDate estimatedValue source createdAt updatedAt")
      .lean();

    const { start, end } = dayBounds();
    const nonTerminal = leads.filter((l) => !TERMINAL.has(l.stage));

    // ── my-day + alerts (all real counts) ──
    let overdue = 0, dueToday = 0, noFollowUp = 0, unassigned = 0;
    let todaySiteVisit = null;
    for (const l of nonTerminal) {
      const fu = l.followUpDate ? new Date(l.followUpDate) : null;
      if (fu && fu < start) overdue++;
      else if (fu && fu >= start && fu <= end) dueToday++;
      if (!fu) noFollowUp++;
      if (!l.assignedTo) unassigned++;
      if (l.stage === "site_visit_scheduled" && fu && fu >= start && fu <= end && !todaySiteVisit) {
        todaySiteVisit = { _id: l._id, name: leadName(l), estimatedValue: l.estimatedValue || 0 };
      }
    }

    // my open tasks due by end of today
    const taskOr = memberId ? [{ assignedTo: memberId }, { createdBy: actorId }] : [{ createdBy: actorId }];
    const myTasksOpen = await VenueTask.countDocuments({
      venue: venue._id,
      status: "open",
      dueAt: { $lte: end },
      $or: taskOr,
    });

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

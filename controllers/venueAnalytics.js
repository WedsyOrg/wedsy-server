/**
 * controllers/venueAnalytics.js — Phase 4.1 analytics.
 * GET /venues/:slug/analytics?from&to (venueOwnerAuth + ownership).
 *
 * Returns enquiry volume (by week/month), funnel + conversion, source
 * attribution, lost-reason breakdown, and revenue (confirmed vs received by
 * month). Response-time is intentionally omitted (no timestamped first-response
 * data is captured yet) — see `responseTime: null`.
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueView = require("../models/VenueView");

// Pipeline order — used to compute "reached stage X or beyond".
const STAGE_ORDER = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];
const stageIdx = (s) => STAGE_ORDER.indexOf(s);

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
// ISO-ish week key: year-Www based on the Thursday of that week.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}
function tally(list) {
  const map = new Map();
  for (const k of list) map.set(k, (map.get(k) || 0) + 1);
  return map;
}
function mapToSortedArray(map, keyName) {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({ [keyName]: k, count: v }));
}

const getAnalytics = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    // A date-only "to" (YYYY-MM-DD) parses to midnight UTC, which silently
    // excludes everything created later that same day — i.e. today's leads
    // never appear in any bounded range. Make it inclusive end-of-day.
    if (toDate && !isNaN(toDate) && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
      toDate.setUTCHours(23, 59, 59, 999);
    }
    const dateFilter = {};
    if (fromDate && !isNaN(fromDate)) dateFilter.$gte = fromDate;
    if (toDate && !isNaN(toDate)) dateFilter.$lte = toDate;

    const enqQuery = { venueId: venue._id };
    if (Object.keys(dateFilter).length) enqQuery.createdAt = dateFilter;
    const enquiries = await VenueEnquiry.find(enqQuery).select("stage source lostReason createdAt").lean();

    const total = enquiries.length;

    // Volume by week / month (on createdAt).
    const byWeek = tally(enquiries.map((e) => weekKey(new Date(e.createdAt))));
    const byMonth = tally(enquiries.map((e) => monthKey(new Date(e.createdAt))));

    // Funnel: leads that reached each milestone (current stage at-or-beyond it),
    // with "lost" excluded from the at-or-beyond test (lost is a terminal branch).
    const reached = (target) => enquiries.filter((e) => e.stage !== "lost" && stageIdx(e.stage) >= stageIdx(target)).length;
    const newCount = total;
    const siteVisitDone = reached("site_visit_done");
    const booked = enquiries.filter((e) => e.stage === "booked").length;
    const funnel = {
      new: newCount,
      site_visit_done: siteVisitDone,
      booked,
      conversion: {
        siteVisitRate: total ? Math.round((siteVisitDone / total) * 1000) / 10 : 0,
        bookingRate: total ? Math.round((booked / total) * 1000) / 10 : 0,
      },
    };

    // Source attribution: count + booked-rate per source.
    const bySource = {};
    for (const e of enquiries) {
      const s = e.source || "other";
      bySource[s] = bySource[s] || { source: s, count: 0, booked: 0 };
      bySource[s].count += 1;
      if (e.stage === "booked") bySource[s].booked += 1;
    }
    const sources = Object.values(bySource)
      .map((r) => ({ ...r, bookedRate: r.count ? Math.round((r.booked / r.count) * 1000) / 10 : 0 }))
      .sort((a, b) => b.count - a.count);

    // Lost-reason breakdown (only leads that are lost, with a reason set).
    const lostReasons = mapToSortedArray(
      tally(enquiries.filter((e) => e.stage === "lost" && e.lostReason).map((e) => e.lostReason)),
      "reason"
    );

    // Revenue by month: confirmed (booking.totalValue by booking.createdAt) vs
    // received (invoice payments by payment date).
    const bookings = await VenueBooking.find({ venue: venue._id, status: { $ne: "cancelled" } }).select("totalValue createdAt").lean();
    const invoices = await VenueInvoice.find({ venue: venue._id }).select("payments").lean();
    const revByMonth = {};
    const bump = (key, field, amount) => {
      revByMonth[key] = revByMonth[key] || { month: key, confirmed: 0, received: 0 };
      revByMonth[key][field] += amount;
    };
    for (const b of bookings) bump(monthKey(new Date(b.createdAt)), "confirmed", Number(b.totalValue) || 0);
    for (const inv of invoices) {
      for (const p of inv.payments || []) bump(monthKey(new Date(p.date)), "received", Number(p.amount) || 0);
    }
    const revenue = { byMonth: Object.values(revByMonth).sort((a, b) => (a.month < b.month ? -1 : 1)) };

    // Views + view→enquiry conversion (couple-side traffic closing the loop).
    const viewQuery = { venueId: venue._id };
    if (Object.keys(dateFilter).length) viewQuery.viewedAt = dateFilter;
    const viewCount = await VenueView.countDocuments(viewQuery);
    const traffic = {
      views: viewCount,
      enquiries: total,
      // % of viewers who enquired (capped at 100; 0 when no views).
      conversionRate: viewCount > 0 ? Math.min(100, Math.round((total / viewCount) * 1000) / 10) : 0,
    };

    return res.status(200).json({
      range: { from: fromDate || null, to: toDate || null },
      total,
      volume: { byWeek: mapToSortedArray(byWeek, "period"), byMonth: mapToSortedArray(byMonth, "period") },
      funnel,
      sources,
      lostReasons,
      revenue,
      traffic,
      responseTime: null, // omitted: no first-response timestamp data is captured yet
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getAnalytics };

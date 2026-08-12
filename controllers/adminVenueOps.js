/**
 * controllers/adminVenueOps.js — MB-V2 P0 S1: Wedsy-internal venue workspace reads.
 *
 * Admin-only (CheckAdminLogin upstream). All read-only: the venue directory
 * with claim-state/completeness facets, the Venue-360 summary, the per-venue
 * leads tab (D1 Version A — every lead the venue has, labeled source/creator,
 * NO writes), and the per-venue activity feed (E6 spine, dual-actor filters).
 */
const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueClaimRequest = require("../models/VenueClaimRequest");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueActivity = require("../models/VenueActivity");
const VenueBooking = require("../models/VenueBooking");
const VenueQuote = require("../models/VenueQuote");
const VenueBill = require("../models/VenueBill");
const VenueInvoice = require("../models/VenueInvoice");
const VenueContract = require("../models/VenueContract");
const VenueConversation = require("../models/VenueConversation");
const VenueHold = require("../models/VenueHold");
const tracks = require("../utils/venueTracks");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLAIM_STATES = ["claimed", "pending", "unclaimed"];

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

// MB-OSV S2 — the two-track derivations, expressed for the aggregation layer.
// These MUST stay in lockstep with utils/venueTracks.js, which is the JS
// implementation every non-pipeline read uses; the S2 test asserts the two
// agree venue-by-venue rather than trusting that they do.
const PARTNER_STAGES = ["none", "access_granted", "live", "onboarding_complete"];

// verified.isVerified when present, else the legacy status === "verified".
const verifiedBadgeExpr = {
  $cond: [
    { $eq: [{ $type: "$verified.isVerified" }, "bool"] },
    "$verified.isVerified",
    { $eq: ["$status", "verified"] },
  ],
};

// A conjunction, exactly as in venueTracks.partnerBadge: we granted access AND
// they actually signed in.
const partnerBadgeExpr = {
  $and: [
    { $ne: [{ $ifNull: ["$partner.accessGrantedAt", null] }, null] },
    { $ne: [{ $ifNull: ["$partner.firstOwnerLoginAt", null] }, null] },
  ],
};

const ENRICHED_MIN = tracks.ENRICHED_MIN_COMPLETENESS;
const enrichmentStageExpr = {
  $cond: [
    { $eq: [{ $ifNull: ["$enrichment.lastEnrichedAt", null] }, null] },
    "raw",
    {
      $cond: [
        {
          $and: [
            { $gte: [{ $ifNull: ["$enrichment.completeness", 0] }, ENRICHED_MIN] },
            { $eq: [{ $size: { $ifNull: ["$enrichment.missingFields", []] } }, 0] },
          ],
        },
        "enriched",
        "enriching",
      ],
    },
  ],
};

const partnerStageExpr = {
  $cond: [
    { $eq: [{ $ifNull: ["$partner.accessGrantedAt", null] }, null] },
    "none",
    {
      $cond: [
        { $eq: [{ $ifNull: ["$partner.firstOwnerLoginAt", null] }, null] },
        "access_granted",
        {
          $cond: [
            { $eq: [{ $ifNull: ["$partner.onboarding.status", "not_started"] }, "complete"] },
            "onboarding_complete",
            "live",
          ],
        },
      ],
    },
  ],
};

// claimed := an active VenueOwner exists (or legacy vendorId is set);
// pending := an open manual-review claim request; else unclaimed.
const claimStateExpr = {
  $cond: [
    {
      $or: [
        { $gt: [{ $size: "$activeOwners" }, 0] },
        { $ne: [{ $ifNull: ["$vendorId", null] }, null] },
      ],
    },
    "claimed",
    { $cond: [{ $gt: [{ $size: "$pendingClaims" }, 0] }, "pending", "unclaimed"] },
  ],
};

const directory = async (req, res) => {
  try {
    const {
      search, zone, status, venueType, claimState, sort,
      // MB-OSV S2 — Track A and Track B facets. Deliberately INDEPENDENT
      // filters: the point of the two-track split is that "verified but never
      // approached" and "live partner nobody has data-checked" are both real
      // states someone needs to be able to find.
      enrichmentStage, verified, partnerStage, onboardingStatus, entryPoint,
    } = req.query;
    const limit = intParam(req.query.limit, 20, 100);
    const skip = intParam(req.query.skip, 0);
    if (claimState && !CLAIM_STATES.includes(claimState)) {
      return res.status(400).json({ message: "Unknown claimState" });
    }
    if (enrichmentStage && !tracks.ENRICHMENT_STAGES.includes(enrichmentStage)) {
      return res.status(400).json({ message: "Unknown enrichmentStage" });
    }
    if (verified && !["true", "false"].includes(verified)) {
      return res.status(400).json({ message: "verified must be true|false" });
    }
    if (partnerStage && !PARTNER_STAGES.includes(partnerStage)) {
      return res.status(400).json({ message: "Unknown partnerStage" });
    }
    if (onboardingStatus && !tracks.ONBOARDING_STATUSES.includes(onboardingStatus)) {
      return res.status(400).json({ message: "Unknown onboardingStatus" });
    }
    if (entryPoint && !tracks.ENTRY_POINTS.includes(entryPoint)) {
      return res.status(400).json({ message: "Unknown entryPoint" });
    }
    const sortMap = {
      completeness: { dataCompleteness: 1, _id: 1 },
      "-completeness": { dataCompleteness: -1, _id: 1 },
      name: { name: 1, _id: 1 },
      "-name": { name: -1, _id: 1 },
      updatedAt: { updatedAt: 1, _id: 1 },
      "-updatedAt": { updatedAt: -1, _id: 1 },
    };
    if (sort && !sortMap[sort]) return res.status(400).json({ message: "Unknown sort" });

    const match = {};
    if (search) match.name = { $regex: escapeRegex(String(search).slice(0, 100)), $options: "i" };
    if (zone) match.zone = String(zone).slice(0, 40);
    if (status) match.status = String(status).slice(0, 40);
    if (venueType) match.venueType = String(venueType).slice(0, 40);
    if (entryPoint) match.entryPoint = entryPoint;
    // Verified matches the DERIVED badge, legacy fallback included — filtering
    // on the raw boolean alone would hide every venue the backfill hasn't
    // reached yet, which is the opposite of what an ops filter is for.
    if (verified === "true") {
      match.$or = [{ "verified.isVerified": true }, { "verified.isVerified": { $exists: false }, status: "verified" }];
    } else if (verified === "false") {
      match["verified.isVerified"] = { $ne: true };
      match.status = match.status || { $ne: "verified" };
    }
    if (onboardingStatus) match["partner.onboarding.status"] = onboardingStatus;

    const [result] = await Venue.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "venueowners",
          let: { vid: "$_id" },
          pipeline: [
            // ANY active VenueOwner doc = claimed. The collection is the
            // primary-account table; `role` is a title (a claim approved for a
            // "manager" designation still claims the venue).
            { $match: { $expr: { $and: [{ $eq: ["$venueId", "$$vid"] }, { $eq: ["$isActive", true] }] } } },
            { $limit: 1 },
            { $project: { name: 1, phone: 1, verificationStatus: 1, claimedAt: 1 } },
          ],
          as: "activeOwners",
        },
      },
      {
        $lookup: {
          from: "venueclaimrequests",
          let: { vid: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$venueId", "$$vid"] }, { $eq: ["$status", "pending_manual_review"] }] } } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "pendingClaims",
        },
      },
      {
        $addFields: {
          claimState: claimStateExpr,
          // MB-OSV S2 — the two tracks, DERIVED in the pipeline so the list and
          // the 360 answer from the same rules (utils/venueTracks) and no
          // denormalised copy can drift.
          verifiedBadge: verifiedBadgeExpr,
          partnerBadge: partnerBadgeExpr,
          enrichmentStage: enrichmentStageExpr,
          partnerStage: partnerStageExpr,
        },
      },
      ...(claimState ? [{ $match: { claimState } }] : []),
      // Stage filters run AFTER the derivation, since that is the only place
      // these values exist.
      ...(enrichmentStage ? [{ $match: { enrichmentStage } }] : []),
      ...(partnerStage ? [{ $match: { partnerStage } }] : []),
      {
        $facet: {
          rows: [
            { $sort: sortMap[sort] || { updatedAt: -1, _id: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, slug: 1, venueType: 1, city: 1, zone: 1, status: 1,
                dataCompleteness: 1, claimState: 1, googleRating: 1,
                googleReviewCount: 1, updatedAt: 1,
                entryPoint: { $ifNull: ["$entryPoint", ""] },
                verifiedBadge: 1, partnerBadge: 1,
                enrichmentStage: 1, partnerStage: 1,
                owner: { $arrayElemAt: ["$activeOwners", 0] },
                enquiryCount: { $size: { $ifNull: ["$enquiries", []] } },
              },
            },
          ],
          total: [{ $count: "n" }],
        },
      },
    ]);
    return res.status(200).json({
      venues: result.rows,
      total: result.total.length ? result.total[0].n : 0,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const venueSummary = async (req, res) => {
  try {
    const venue = await Venue.findOne({ slug: req.params.slug })
      .select("-googleReviews -competitiveCache -enquiries")
      .lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    const vid = venue._id;
    const [
      enquiries, bookings, quotes, bills, invoices, contracts, conversations,
      holdsByStatus, owners, pendingClaim,
    ] = await Promise.all([
      VenueEnquiry.countDocuments({ venueId: vid }),
      VenueBooking.countDocuments({ venue: vid }),
      VenueQuote.countDocuments({ venue: vid }),
      VenueBill.countDocuments({ venue: vid }),
      VenueInvoice.countDocuments({ venue: vid }),
      VenueContract.countDocuments({ venue: vid }),
      VenueConversation.countDocuments({ venueId: vid }),
      VenueHold.aggregate([{ $match: { venue: vid } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      VenueOwner.find({ venueId: vid, isActive: true })
        .select("name phone email role verificationStatus claimedAt lastLoginAt")
        .lean(),
      VenueClaimRequest.findOne({ venueId: vid, status: "pending_manual_review" })
        .sort({ createdAt: -1 })
        .lean(),
    ]);
    const holds = {};
    for (const h of holdsByStatus) holds[h._id] = h.n;
    const hasOwner = owners.length > 0 || !!venue.vendorId;
    const claimState = hasOwner ? "claimed" : pendingClaim ? "pending" : "unclaimed";
    return res.status(200).json({
      venue,
      counts: { enquiries, bookings, quotes, bills, invoices, contracts, conversations, holds },
      owners,
      pendingClaim,
      claimState,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// D1 Version A: the creator label is DERIVED (no schema change) from the
// enquiry's first "created" activity — manual/import descriptions mean the
// venue team keyed it in; the plain public-flow description means the couple.
const createdByOf = (enquiry) => {
  const created = (enquiry.activities || []).find((a) => a && a.type === "created");
  if (!created) return "unknown";
  return /manual|import/i.test(created.description || "") ? "venue_team" : "couple";
};

const listVenueEnquiries = async (req, res) => {
  try {
    const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    const { source, stage, from, to } = req.query;
    const filter = { venueId: venue._id };
    if (source) {
      const allowed = VenueEnquiry.schema.path("source").enumValues;
      if (!allowed.includes(source)) return res.status(400).json({ message: "Unknown source" });
      filter.source = source;
    }
    if (stage) {
      const allowed = VenueEnquiry.schema.path("stage").enumValues;
      if (!allowed.includes(stage)) return res.status(400).json({ message: "Unknown stage" });
      filter.stage = stage;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "from is not a valid date" });
        filter.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "to is not a valid date" });
        filter.createdAt.$lte = d;
      }
    }
    const limit = intParam(req.query.limit, 50, 100);
    const skip = intParam(req.query.skip, 0);
    const [rows, total] = await Promise.all([
      VenueEnquiry.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .select("name phone coupleName couplePhone email eventDate guestCount budget source stage status estimatedValue assignedTo crmLeadRef createdAt activities")
        .lean(),
      VenueEnquiry.countDocuments(filter),
    ]);
    const enquiries = rows.map(({ activities, ...rest }) => ({
      ...rest,
      createdBy: createdByOf({ activities }),
    }));
    return res.status(200).json({ enquiries, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// E6 feed, admin read — same filter contract as the owner-side
// venueActivityFeed.listActivity plus `field` (exact dotted path) and skip.
const listVenueActivity = async (req, res) => {
  try {
    const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    const filter = { venue: venue._id };
    const { severity, entity, actorType, field, from, to } = req.query;
    if (severity) {
      const list = String(severity).split(",").filter(Boolean);
      if (list.some((s) => !["high", "normal", "low"].includes(s))) return res.status(400).json({ message: "Unknown severity" });
      filter.severity = { $in: list };
    }
    if (entity) filter.entity = String(entity).slice(0, 100);
    if (field) filter.field = String(field).slice(0, 200);
    if (actorType) {
      if (!["venue_team", "wedsy_team", "system"].includes(actorType)) return res.status(400).json({ message: "Unknown actorType" });
      filter.actorType = actorType;
    }
    if (from || to) {
      filter.at = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "from is not a valid date" });
        filter.at.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "to is not a valid date" });
        filter.at.$lte = d;
      }
    }
    const limit = intParam(req.query.limit, 100, 500);
    const skip = intParam(req.query.skip, 0);
    const [activity, total] = await Promise.all([
      VenueActivity.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
      VenueActivity.countDocuments(filter),
    ]);
    return res.status(200).json({ activity, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// P0 S5 (D10) — cross-venue firehose. Same filter contract as the per-venue
// feed, venue-populated; defaults to severity=high (that's the firehose's
// job — the full trail lives on each venue's Activity tab).
const activityFirehose = async (req, res) => {
  try {
    const filter = {};
    const { severity, entity, actorType, field, from, to, slug } = req.query;
    if (slug) {
      const venue = await Venue.findOne({ slug: String(slug) }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venue = venue._id;
    }
    const sev = severity === undefined || severity === "" ? "high" : String(severity);
    if (sev !== "all") {
      const list = sev.split(",").filter(Boolean);
      if (list.some((s) => !["high", "normal", "low"].includes(s))) return res.status(400).json({ message: "Unknown severity" });
      filter.severity = { $in: list };
    }
    if (entity) filter.entity = String(entity).slice(0, 100);
    if (field) filter.field = String(field).slice(0, 200);
    if (actorType) {
      if (!["venue_team", "wedsy_team", "system"].includes(actorType)) return res.status(400).json({ message: "Unknown actorType" });
      filter.actorType = actorType;
    }
    if (from || to) {
      filter.at = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "from is not a valid date" });
        filter.at.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "to is not a valid date" });
        filter.at.$lte = d;
      }
    }
    const limit = intParam(req.query.limit, 100, 500);
    const skip = intParam(req.query.skip, 0);
    const [activity, total] = await Promise.all([
      VenueActivity.find(filter)
        .sort({ at: -1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug zone")
        .lean(),
      VenueActivity.countDocuments(filter),
    ]);
    return res.status(200).json({ activity, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// P3 — notification mesh read (the triggers write; this surfaces the table).
const VenueNotification = require("../models/VenueNotification");
const listNotifications = async (req, res) => {
  try {
    const filter = {};
    const { type } = req.query;
    if (type) {
      if (!VenueNotification.schema.path("type").enumValues.includes(type)) {
        return res.status(400).json({ message: "Unknown type" });
      }
      filter.type = type;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [notifications, total] = await Promise.all([
      VenueNotification.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug")
        .lean(),
      VenueNotification.countDocuments(filter),
    ]);
    return res.status(200).json({ notifications, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { directory, venueSummary, listVenueEnquiries, listVenueActivity, activityFirehose, listNotifications };

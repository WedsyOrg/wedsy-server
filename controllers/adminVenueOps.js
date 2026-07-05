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

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLAIM_STATES = ["claimed", "pending", "unclaimed"];

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
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
    const { search, zone, status, venueType, claimState, sort } = req.query;
    const limit = intParam(req.query.limit, 20, 100);
    const skip = intParam(req.query.skip, 0);
    if (claimState && !CLAIM_STATES.includes(claimState)) {
      return res.status(400).json({ message: "Unknown claimState" });
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
      { $addFields: { claimState: claimStateExpr } },
      ...(claimState ? [{ $match: { claimState } }] : []),
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
        .select("name phone coupleName couplePhone email eventDate guestCount budget source stage status estimatedValue assignedTo createdAt activities")
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

module.exports = { directory, venueSummary, listVenueEnquiries, listVenueActivity };

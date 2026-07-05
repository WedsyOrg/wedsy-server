/**
 * controllers/adminVenueQueues.js — MB-V2 P0 S2 (D11): the Wedsy-side queues.
 *
 * Claim Requests: list/read + approve/reject WIRED INTO the existing claim
 * machinery (VenueClaimRequest reviewed fields + the same VenueOwner upsert
 * verifyClaim performs; new_venue_signup approvals create the Venue through
 * VenueService so slug/status rules hold). Onboarding Requests: list + guarded
 * status transitions over VenueOnboardingRequest. Partner board: a derived
 * kanban over both (no new state — stages are computed, not stored).
 *
 * All handlers run behind CheckAdminLogin (req.auth), writes log to the E6
 * activity spine as wedsy_team with the real admin name.
 */
const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueClaimRequest = require("../models/VenueClaimRequest");
const VenueOnboardingRequest = require("../models/VenueOnboardingRequest");
const VenueService = require("../services/VenueService");
const { logActivity, snap } = require("../utils/venueActivity");

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

const adminActor = (req) => ({
  type: "wedsy_team",
  id: req.auth && req.auth.user_id,
  name: (req.auth && req.auth.user && req.auth.user.name) || "Wedsy admin",
});

// ─── Claim requests ────────────────────────────────────────────────────────

const listClaims = async (req, res) => {
  try {
    const { status, tier } = req.query;
    const filter = {};
    if (status) {
      const allowed = VenueClaimRequest.schema.path("status").enumValues;
      if (!allowed.includes(status)) return res.status(400).json({ message: "Unknown status" });
      filter.status = status;
    }
    if (tier) {
      const allowed = VenueClaimRequest.schema.path("tier").enumValues;
      if (!allowed.includes(tier)) return res.status(400).json({ message: "Unknown tier" });
      filter.tier = tier;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [requests, total] = await Promise.all([
      VenueClaimRequest.find(filter).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit)
        .populate("reviewedBy", "name").lean(),
      VenueClaimRequest.countDocuments(filter),
    ]);
    return res.status(200).json({ requests, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getClaim = async (req, res) => {
  try {
    const request = await VenueClaimRequest.findById(req.params.id)
      .populate("reviewedBy", "name").lean();
    if (!request) return res.status(404).json({ message: "Claim request not found" });
    // Context for the review screen: current owner (conflict surface) if the
    // claim targets an existing venue.
    let currentOwner = null;
    if (request.venueId) {
      currentOwner = await VenueOwner.findOne({ venueId: request.venueId, isActive: true })
        .select("name phone verificationStatus claimedAt").lean();
    }
    return res.status(200).json({ request, currentOwner });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    return res.status(500).json({ message: err.message });
  }
};

const approveClaim = async (req, res) => {
  try {
    const reviewNote = typeof req.body.reviewNote === "string" ? req.body.reviewNote.slice(0, 2000) : "";
    const request = await VenueClaimRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Claim request not found" });
    if (request.status !== "pending_manual_review") {
      return res.status(409).json({ message: `Request already ${request.status}` });
    }

    // Resolve/create the venue.
    let venue;
    if (request.venueId) {
      venue = await Venue.findById(request.venueId).select("_id name slug status").lean();
      if (!venue) return res.status(404).json({ message: "Venue no longer exists" });
    } else {
      // new_venue_signup: create the venue through the service (slug + draft
      // status rules live there). Free-text venue type maps into the enum.
      const typeEnum = Venue.schema.path("venueType").enumValues;
      const rawType = (request.newVenueType || "").toLowerCase().trim();
      venue = await VenueService.createVenue({
        name: request.newVenueName,
        venueType: typeEnum.includes(rawType) ? rawType : "other",
        address: request.newVenueAddress || "",
      });
    }

    // Same conflict rule as the self-serve flow, but explicit: an ACTIVE owner
    // account with a DIFFERENT phone blocks approval (admin must resolve).
    const existingOwner = await VenueOwner.findOne({ venueId: venue._id, isActive: true });
    if (existingOwner && existingOwner.phone !== request.phone) {
      return res.status(409).json({ message: "Venue already has an active owner with a different phone. Resolve ownership first." });
    }

    // Mirror verifyClaim's upsert; admin review lands at "verified".
    let owner = existingOwner || (await VenueOwner.findOne({ venueId: venue._id, phone: request.phone }));
    if (!owner) {
      owner = new VenueOwner({
        name: request.name,
        phone: request.phone,
        email: request.email || "",
        role: request.designation || "owner",
        venueId: venue._id,
        verificationStatus: "verified",
        claimedAt: new Date(),
        isActive: true,
      });
    } else {
      owner.verificationStatus = "verified";
      owner.claimedAt = owner.claimedAt || new Date();
      owner.isActive = true;
    }
    await owner.save();

    request.status = "approved";
    request.reviewedBy = req.auth.user_id;
    request.reviewedAt = new Date();
    request.reviewNote = reviewNote;
    if (!request.venueId) {
      request.venueId = venue._id;
      request.venueName = venue.name;
      request.venueSlug = venue.slug;
    }
    await request.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "claim_approved",
      entity: "claim",
      field: "claim.status",
      old: snap("pending_manual_review"),
      new: snap("approved"),
      severity: "high",
    });

    return res.status(200).json({
      request: request.toObject(),
      owner: { _id: owner._id, name: owner.name, phone: owner.phone, role: owner.role, verificationStatus: owner.verificationStatus },
      venue: { _id: venue._id, name: venue.name, slug: venue.slug },
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    if (err.status === 400) return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

const rejectClaim = async (req, res) => {
  try {
    const reviewNote = typeof req.body.reviewNote === "string" ? req.body.reviewNote.slice(0, 2000) : "";
    const request = await VenueClaimRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Claim request not found" });
    if (request.status !== "pending_manual_review") {
      return res.status(409).json({ message: `Request already ${request.status}` });
    }
    request.status = "rejected";
    request.reviewedBy = req.auth.user_id;
    request.reviewedAt = new Date();
    request.reviewNote = reviewNote;
    await request.save();

    if (request.venueId) {
      const actor = adminActor(req);
      logActivity({
        venue: request.venueId,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "claim_rejected",
        entity: "claim",
        field: "claim.status",
        old: snap("pending_manual_review"),
        new: snap("rejected"),
        severity: "high",
      });
    }
    return res.status(200).json({ request: request.toObject() });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    return res.status(500).json({ message: err.message });
  }
};

// ─── Onboarding requests ───────────────────────────────────────────────────

// Forward-only transitions (D11): converted and dropped are terminal.
const ONBOARDING_TRANSITIONS = {
  new: ["contacted", "converted", "dropped"],
  contacted: ["converted", "dropped"],
  converted: [],
  dropped: [],
};

const listOnboardingRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) {
      const allowed = VenueOnboardingRequest.schema.path("status").enumValues;
      if (!allowed.includes(status)) return res.status(400).json({ message: "Unknown status" });
      filter.status = status;
    }
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const [requests, total] = await Promise.all([
      VenueOnboardingRequest.find(filter).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit).lean(),
      VenueOnboardingRequest.countDocuments(filter),
    ]);
    return res.status(200).json({ requests, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateOnboardingRequest = async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowed = VenueOnboardingRequest.schema.path("status").enumValues;
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ message: "status must be one of: " + allowed.join(", ") });
    }
    const request = await VenueOnboardingRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Onboarding request not found" });
    if (!ONBOARDING_TRANSITIONS[request.status].includes(status)) {
      return res.status(409).json({ message: `Cannot move ${request.status} → ${status}` });
    }
    request.status = status;
    await request.save();
    return res.status(200).json({ request: request.toObject() });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    return res.status(500).json({ message: err.message });
  }
};

// ─── Partner board ─────────────────────────────────────────────────────────

// Derived kanban (no stored stage): prospect → contacted → onboarded → live.
//   prospect  = onboarding requests (new) + unclaimed draft venues
//   contacted = onboarding requests (contacted) + outreach-stage venues
//   onboarded = claimed venues not yet publicly listed
//   live      = claimed venues that are published/verified
const PARTNER_COLUMN_CAP = 100;

const partnerBoard = async (req, res) => {
  try {
    const [onbNew, onbContacted, venues] = await Promise.all([
      VenueOnboardingRequest.find({ status: "new" }).sort({ createdAt: -1 }).limit(PARTNER_COLUMN_CAP).lean(),
      VenueOnboardingRequest.find({ status: "contacted" }).sort({ createdAt: -1 }).limit(PARTNER_COLUMN_CAP).lean(),
      Venue.aggregate([
        {
          $lookup: {
            from: "venueowners",
            let: { vid: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$venueId", "$$vid"] }, { $eq: ["$isActive", true] }] } } },
              { $limit: 1 },
              { $project: { name: 1, phone: 1 } },
            ],
            as: "activeOwners",
          },
        },
        {
          $project: {
            name: 1, slug: 1, city: 1, zone: 1, status: 1, dataCompleteness: 1, updatedAt: 1,
            owner: { $arrayElemAt: ["$activeOwners", 0] },
            claimed: {
              $or: [
                { $gt: [{ $size: "$activeOwners" }, 0] },
                { $ne: [{ $ifNull: ["$vendorId", null] }, null] },
              ],
            },
          },
        },
      ]),
    ]);

    const onbCard = (r) => ({
      kind: "onboarding_request",
      _id: r._id,
      name: r.venueName || r.name,
      contactName: r.name,
      phone: r.phone,
      city: r.city,
      status: r.status,
      createdAt: r.createdAt,
    });
    const venueCard = (v) => ({
      kind: "venue",
      _id: v._id,
      name: v.name,
      slug: v.slug,
      city: v.city,
      zone: v.zone,
      status: v.status,
      dataCompleteness: v.dataCompleteness,
      owner: v.owner || null,
      updatedAt: v.updatedAt,
    });

    const columns = { prospect: [], contacted: [], onboarded: [], live: [] };
    for (const r of onbNew) columns.prospect.push(onbCard(r));
    for (const r of onbContacted) columns.contacted.push(onbCard(r));
    for (const v of venues) {
      if (v.claimed) {
        (["published", "verified"].includes(v.status) ? columns.live : columns.onboarded).push(venueCard(v));
      } else if (v.status === "draft") {
        columns.prospect.push(venueCard(v));
      } else if (["pending_outreach", "outreach_sent"].includes(v.status)) {
        columns.contacted.push(venueCard(v));
      }
      // unclaimed published/verified/rejected venues are marketplace listings,
      // not partnership-pipeline cards — intentionally not on the board.
    }
    const counts = {};
    for (const key of Object.keys(columns)) {
      counts[key] = columns[key].length;
      columns[key] = columns[key].slice(0, PARTNER_COLUMN_CAP);
    }
    return res.status(200).json({ columns, counts });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listClaims,
  getClaim,
  approveClaim,
  rejectClaim,
  listOnboardingRequests,
  updateOnboardingRequest,
  partnerBoard,
};

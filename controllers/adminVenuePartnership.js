/**
 * controllers/adminVenuePartnership.js — MB-OSV S0: the two-track write surface.
 *
 * Admin-only (CheckAdminLogin + requirePermission upstream). This is the OS
 * team acting ON venues: verifying data (Track A), granting partner access and
 * running onboarding (Track B), logging partner visits, recording lead assists,
 * and reading the week's worklist.
 *
 * BOUNDARY — every route here is admin-JWT gated ({_id, isAdmin:true}) and none
 * of them is reachable with a venue-owner token. Nothing in this file writes to
 * a venue's own CRM: no moving their leads, no editing their pipeline. The OS
 * watches the venue and acts on the RELATIONSHIP, not inside their workspace.
 */
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenuePartnerVisit = require("../models/VenuePartnerVisit");
const VenueLeadAssist = require("../models/VenueLeadAssist");
const VenueWorkTarget = require("../models/VenueWorkTarget");
// Required for its side effect: listLeadAssists populates the CRM lead, and
// mongoose can only resolve the "Enquiry" ref if that model is registered.
// The full server loads it anyway; this makes the controller self-sufficient
// so a narrower entry point (a test, a script, a worker) cannot 500 on it.
require("../models/Enquiry");
const { logActivity, snap } = require("../utils/venueActivity");
// Bulk re-checks capability per action, so it needs the gate primitives directly.
const { permissionSatisfies, permissionsForAdmin } = require("../middlewares/requirePermission");
const AdminRepository = require("../repositories/AdminRepository");
const tracks = require("../utils/venueTracks");
const T = require("../utils/venueTime");

// ── shared helpers ──────────────────────────────────────────────────────────

const adminActor = (req) => ({
  type: "wedsy_team",
  id: req.auth && req.auth.user_id,
  name: "Wedsy admin",
});

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

// Resolve :slug → venue doc, or send the 404 and return null.
async function loadVenue(req, res, projection) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(projection);
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  return venue;
}

// The shape every partnership read returns, so the OS renders one contract.
function partnershipView(venue) {
  const p = venue.partner || {};
  const v = venue.verified || {};
  const e = venue.enrichment || {};
  return {
    slug: venue.slug,
    name: venue.name,
    status: venue.status,
    entryPoint: venue.entryPoint || "",
    ...tracks.trackSummary(venue),
    verified: {
      isVerified: tracks.verifiedBadge(venue),
      verifiedBy: v.verifiedBy || null,
      verifiedAt: v.verifiedAt || null,
      notes: v.notes || "",
    },
    enrichment: {
      completeness: typeof e.completeness === "number" ? e.completeness : 0,
      missingFields: e.missingFields || [],
      lastEnrichedBy: e.lastEnrichedBy || null,
      lastEnrichedAt: e.lastEnrichedAt || null,
    },
    partner: {
      accessGrantedAt: p.accessGrantedAt || null,
      accessGrantedBy: p.accessGrantedBy || null,
      accessGrantTrigger: p.accessGrantTrigger || null,
      primaryPhone: p.primaryPhone || "",
      primaryEmail: p.primaryEmail || "",
      firstOwnerLoginAt: p.firstOwnerLoginAt || null,
      terms: {
        unconditional: p.terms && typeof p.terms.unconditional === "boolean" ? p.terms.unconditional : true,
        commissionPercent: p.terms ? (p.terms.commissionPercent ?? null) : null,
        inHousePlanner: Boolean(p.terms && p.terms.inHousePlanner),
        decorRights: Boolean(p.terms && p.terms.decorRights),
      },
      onboarding: {
        status: (p.onboarding && p.onboarding.status) || "not_started",
        stages: (p.onboarding && p.onboarding.stages) || [],
        agreementDocUrl: (p.onboarding && p.onboarding.agreementDocUrl) || "",
        ownerId: (p.onboarding && p.onboarding.ownerId) || null,
      },
    },
  };
}

const PARTNERSHIP_FIELDS =
  "_id name slug status entryPoint verified enrichment partner dataCompleteness";

// ── GET /:slug/partnership — the 360 partnership panel ──────────────────────
const getPartnership = async (req, res) => {
  try {
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;
    const [visits, ownerCount] = await Promise.all([
      VenuePartnerVisit.find({ venue: venue._id })
        .sort({ visitedAt: -1 })
        .limit(20)
        .populate("visitedBy", "name email")
        .lean(),
      VenueOwner.countDocuments({ venueId: venue._id, isActive: true }),
    ]);
    return res.status(200).json({
      ...partnershipView(venue),
      activeOwnerCount: ownerCount,
      visits,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /:slug/verify — Track A terminal, set OR unset ────────────────────
// Verification is revocable by design: it says "we checked this", and when that
// stops being true it must be retractable WITHOUT touching the listing's
// publication status. That was impossible while both lived in `status`.
const setVerified = async (req, res) => {
  try {
    if (typeof req.body.isVerified !== "boolean") {
      return res.status(400).json({ message: "isVerified (boolean) is required" });
    }
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;

    const notes = str(req.body.notes, 2000);
    const actorId = req.auth.user_id;
    const was = tracks.verifiedBadge(venue);

    venue.verified = venue.verified || {};
    venue.verified.isVerified = req.body.isVerified;
    venue.verified.notes = notes;
    if (req.body.isVerified) {
      venue.verified.verifiedBy = actorId;
      venue.verified.verifiedAt = new Date();
    } else {
      // Keep WHO un-verified it and WHEN — an unverify is as much of an audit
      // event as a verify, and blanking the fields would erase it.
      venue.verified.verifiedBy = actorId;
      venue.verified.verifiedAt = new Date();
    }
    await venue.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: req.body.isVerified ? "venue_verified" : "venue_unverified",
      entity: "verification",
      field: "verified.isVerified",
      old: snap(was),
      new: snap({ isVerified: req.body.isVerified, notes }),
      severity: "high",
    });

    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /:slug/enrichment — Track A progression ───────────────────────────
const setEnrichment = async (req, res) => {
  try {
    const { completeness, missingFields } = req.body;
    if (completeness !== undefined) {
      const n = Number(completeness);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ message: "completeness must be a number between 0 and 100" });
      }
    }
    if (missingFields !== undefined && !Array.isArray(missingFields)) {
      return res.status(400).json({ message: "missingFields must be an array of strings" });
    }
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;

    venue.enrichment = venue.enrichment || {};
    if (completeness !== undefined) venue.enrichment.completeness = Number(completeness);
    if (missingFields !== undefined) {
      venue.enrichment.missingFields = missingFields.map((f) => str(f, 80)).filter(Boolean).slice(0, 100);
    }
    venue.enrichment.lastEnrichedBy = req.auth.user_id;
    venue.enrichment.lastEnrichedAt = new Date();
    await venue.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "venue_enriched",
      entity: "enrichment",
      field: "enrichment.completeness",
      new: snap({ completeness: venue.enrichment.completeness, stage: tracks.enrichmentStage(venue) }),
    });

    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /:slug/grant-access — Track B start. ONE action, two triggers ──────
// Both doors (a claim we approved, or a venue we chose) run exactly this code.
// The trigger is recorded as provenance and changes nothing about what happens,
// which is the point: there is one way to become a partner.
//
// primaryPhone is DESIGNATED here, never inferred from venue.contact — the
// number on a scraped listing is often a reception desk, and handing portal
// access to whoever answers it is precisely the mistake this prevents.
const grantAccess = async (req, res) => {
  try {
    const { trigger, primaryPhone, primaryEmail, ownerName } = req.body;
    if (!tracks.ACCESS_GRANT_TRIGGERS.includes(trigger)) {
      return res.status(400).json({
        message: `trigger must be one of ${tracks.ACCESS_GRANT_TRIGGERS.join("|")}`,
      });
    }
    const phone = str(primaryPhone, 20).trim();
    if (!phone) {
      return res.status(400).json({ message: "primaryPhone is required and is never inferred" });
    }
    const email = str(primaryEmail, 160).trim();

    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;

    if (venue.partner && venue.partner.accessGrantedAt) {
      return res.status(409).json({
        message: "Partner access is already granted for this venue",
        grantedAt: venue.partner.accessGrantedAt,
      });
    }

    // An ACTIVE owner on a different phone means ownership is contested. Same
    // rule the claim-approval path already enforces — silently attaching a
    // second login would hand the venue to the wrong person.
    const existingActive = await VenueOwner.findOne({ venueId: venue._id, isActive: true });
    if (existingActive && existingActive.phone !== phone) {
      return res.status(409).json({
        message: "Venue already has an active owner with a different phone. Resolve ownership first.",
      });
    }

    // Create or re-link the owner account. Auth itself is untouched: the owner
    // still signs in with phone OTP through the existing path.
    let owner = existingActive || (await VenueOwner.findOne({ venueId: venue._id, phone }));
    if (!owner) {
      owner = new VenueOwner({
        name: str(ownerName, 120).trim() || venue.name,
        phone,
        email,
        role: "owner",
        venueId: venue._id,
        verificationStatus: "verified",
        claimedAt: new Date(),
        isActive: true,
      });
    } else {
      owner.isActive = true;
      owner.verificationStatus = "verified";
      owner.claimedAt = owner.claimedAt || new Date();
      if (email && !owner.email) owner.email = email;
    }
    await owner.save();

    venue.partner = venue.partner || {};
    venue.partner.accessGrantedAt = new Date();
    venue.partner.accessGrantedBy = req.auth.user_id;
    venue.partner.accessGrantTrigger = trigger;
    venue.partner.primaryPhone = phone;
    venue.partner.primaryEmail = email;
    venue.partner.onboarding = venue.partner.onboarding || {};
    venue.partner.onboarding.ownerId = owner._id;
    // A claim we approved means the venue already came to us — Track B is
    // already moving, so onboarding starts rather than sitting at not_started.
    if (trigger === "claim_approval" && venue.partner.onboarding.status === "not_started") {
      venue.partner.onboarding.status = "in_progress";
    }
    await venue.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "partner_access_granted",
      entity: "partner",
      field: "partner.accessGrantedAt",
      new: snap({ trigger, primaryPhone: phone, ownerId: String(owner._id) }),
      severity: "high",
    });

    return res.status(201).json({
      ...partnershipView(venue),
      owner: { _id: owner._id, name: owner.name, phone: owner.phone, email: owner.email },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /:slug/partner/terms ──────────────────────────────────────────────
// Default posture is unconditional: a venue is a partner without owing anything
// until someone deliberately says otherwise. Setting any commercial term turns
// `unconditional` off, because "unconditional with a 5% commission" is a lie
// the UI should never be able to render.
const setTerms = async (req, res) => {
  try {
    const { unconditional, commissionPercent, inHousePlanner, decorRights } = req.body;
    if (commissionPercent !== undefined && commissionPercent !== null) {
      const n = Number(commissionPercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ message: "commissionPercent must be null or a number between 0 and 100" });
      }
    }
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;

    venue.partner = venue.partner || {};
    venue.partner.terms = venue.partner.terms || {};
    const t = venue.partner.terms;
    if (commissionPercent !== undefined) {
      t.commissionPercent = commissionPercent === null ? null : Number(commissionPercent);
    }
    if (inHousePlanner !== undefined) t.inHousePlanner = Boolean(inHousePlanner);
    if (decorRights !== undefined) t.decorRights = Boolean(decorRights);
    if (unconditional !== undefined) t.unconditional = Boolean(unconditional);

    // Any actual condition contradicts an unconditional partnership.
    const hasCondition =
      (t.commissionPercent !== null && t.commissionPercent !== undefined) ||
      t.inHousePlanner === true ||
      t.decorRights === true;
    if (hasCondition) t.unconditional = false;

    await venue.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "partner_terms_updated",
      entity: "partner",
      field: "partner.terms",
      new: snap({
        unconditional: t.unconditional,
        commissionPercent: t.commissionPercent ?? null,
        inHousePlanner: Boolean(t.inHousePlanner),
        decorRights: Boolean(t.decorRights),
      }),
      severity: "high",
    });

    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /:slug/partner/onboarding — status + agreement doc ────────────────
// Scan-upload only: agreementDocUrl comes from the existing POST /file/upload
// flow. There is no e-sign here and none is implied.
const updateOnboarding = async (req, res) => {
  try {
    const { status, agreementDocUrl } = req.body;
    if (status !== undefined && !tracks.ONBOARDING_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of ${tracks.ONBOARDING_STATUSES.join("|")}`,
      });
    }
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;

    if (!venue.partner || !venue.partner.accessGrantedAt) {
      return res.status(409).json({
        message: "Grant partner access before running onboarding",
      });
    }

    venue.partner.onboarding = venue.partner.onboarding || {};
    if (status !== undefined) venue.partner.onboarding.status = status;
    if (agreementDocUrl !== undefined) {
      venue.partner.onboarding.agreementDocUrl = str(agreementDocUrl, 1000);
    }
    await venue.save();

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "partner_onboarding_updated",
      entity: "partner",
      field: "partner.onboarding.status",
      new: snap({ status: venue.partner.onboarding.status }),
    });

    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PUT /:slug/partner/onboarding/stages/:key — upsert one stage ────────────
const upsertOnboardingStage = async (req, res) => {
  try {
    const key = str(req.params.key, 60).trim();
    if (!key) return res.status(400).json({ message: "stage key is required" });

    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;
    if (!venue.partner || !venue.partner.accessGrantedAt) {
      return res.status(409).json({ message: "Grant partner access before running onboarding" });
    }

    venue.partner.onboarding = venue.partner.onboarding || {};
    const stages = venue.partner.onboarding.stages || [];
    let stage = stages.find((s) => s.key === key);
    if (!stage) {
      // Push, then read the CAST subdocument back out. Mongoose casts the plain
      // object on push and stores the copy, so mutating the literal we passed in
      // would update nothing — every completedAt/completedBy below would be
      // silently dropped on save.
      stages.push({ key, label: str(req.body.label, 120) || key, done: false });
      stage = stages[stages.length - 1];
    }
    if (req.body.label !== undefined) stage.label = str(req.body.label, 120);
    if (req.body.notes !== undefined) stage.notes = str(req.body.notes, 2000);
    if (req.body.done !== undefined) {
      const done = Boolean(req.body.done);
      // Only stamp the completion the first time it flips true, so re-saving a
      // finished stage doesn't keep moving its date.
      if (done && !stage.done) {
        stage.completedAt = new Date();
        stage.completedBy = req.auth.user_id;
      }
      if (!done) {
        stage.completedAt = undefined;
        stage.completedBy = undefined;
      }
      stage.done = done;
    }
    venue.partner.onboarding.stages = stages;

    // Advance the headline status off the stage list rather than making the
    // operator maintain both — but never auto-complete: declaring onboarding
    // finished stays a human call.
    if (stages.some((s) => s.done) && venue.partner.onboarding.status === "not_started") {
      venue.partner.onboarding.status = "in_progress";
    }
    await venue.save();

    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── DELETE /:slug/partner/onboarding/stages/:key ────────────────────────────
const removeOnboardingStage = async (req, res) => {
  try {
    const key = str(req.params.key, 60).trim();
    const venue = await loadVenue(req, res, PARTNERSHIP_FIELDS);
    if (!venue) return;
    const ob = (venue.partner && venue.partner.onboarding) || null;
    if (!ob || !Array.isArray(ob.stages)) return res.status(404).json({ message: "Stage not found" });
    const before = ob.stages.length;
    ob.stages = ob.stages.filter((s) => s.key !== key);
    if (ob.stages.length === before) return res.status(404).json({ message: "Stage not found" });
    await venue.save();
    return res.status(200).json(partnershipView(venue));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── partner visits (internal, Track B) ──────────────────────────────────────

const listPartnerVisits = async (req, res) => {
  try {
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const filter = {};
    // Serves both /partner-visits?slug=… (cross-venue) and
    // /:slug/partner-visits (the 360 tab), so the 360 needs no second handler.
    const slug = req.params.slug || req.query.slug;
    if (slug) {
      const venue = await Venue.findOne({ slug }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venue = venue._id;
    }
    if (req.query.visitedBy && isId(req.query.visitedBy)) filter.visitedBy = req.query.visitedBy;
    if (req.query.outcome) filter.outcome = str(req.query.outcome, 40);

    const [visits, total] = await Promise.all([
      VenuePartnerVisit.find(filter)
        .sort({ visitedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug city")
        .populate("visitedBy", "name email")
        .lean(),
      VenuePartnerVisit.countDocuments(filter),
    ]);
    return res.status(200).json({ visits, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const createPartnerVisit = async (req, res) => {
  try {
    const venue = await loadVenue(req, res, "_id name slug");
    if (!venue) return;
    const when = req.body.visitedAt ? new Date(req.body.visitedAt) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ message: "visitedAt must be a valid date" });

    const allowed = VenuePartnerVisit.schema.path("outcome").enumValues;
    const outcome = req.body.outcome || "pitched";
    if (!allowed.includes(outcome)) {
      return res.status(400).json({ message: `outcome must be one of ${allowed.join("|")}` });
    }

    const visit = await VenuePartnerVisit.create({
      venue: venue._id,
      visitedBy: req.auth.user_id,
      visitedAt: when,
      outcome,
      notes: str(req.body.notes, 4000),
      nextAction: str(req.body.nextAction, 1000),
    });

    const actor = adminActor(req);
    logActivity({
      venue: venue._id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "partner_visit_logged",
      entity: "partner",
      field: "partnerVisit",
      new: snap({ outcome, visitedAt: when, nextAction: str(req.body.nextAction, 200) }),
    });

    return res.status(201).json({ visit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updatePartnerVisit = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid visit id" });
    const visit = await VenuePartnerVisit.findById(req.params.id);
    if (!visit) return res.status(404).json({ message: "Visit not found" });

    if (req.body.outcome !== undefined) {
      const allowed = VenuePartnerVisit.schema.path("outcome").enumValues;
      if (!allowed.includes(req.body.outcome)) {
        return res.status(400).json({ message: `outcome must be one of ${allowed.join("|")}` });
      }
      visit.outcome = req.body.outcome;
    }
    if (req.body.visitedAt !== undefined) {
      const when = new Date(req.body.visitedAt);
      if (isNaN(when.getTime())) return res.status(400).json({ message: "visitedAt must be a valid date" });
      visit.visitedAt = when;
    }
    if (req.body.notes !== undefined) visit.notes = str(req.body.notes, 4000);
    if (req.body.nextAction !== undefined) visit.nextAction = str(req.body.nextAction, 1000);
    await visit.save();
    return res.status(200).json({ visit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const deletePartnerVisit = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid visit id" });
    const visit = await VenuePartnerVisit.findByIdAndDelete(req.params.id);
    if (!visit) return res.status(404).json({ message: "Visit not found" });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── lead assists ("Leads I'm on") ───────────────────────────────────────────
// The CRM's Enquiry model is never written here — this is a venue-owned join
// recording that an admin is helping on a couple-lead. Removing an assist
// removes the assist, and nothing about the lead changes.

const listLeadAssists = async (req, res) => {
  try {
    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const filter = {};
    // Default to the caller's own assists — this screen is "Leads I'm on".
    if (req.query.adminId && isId(req.query.adminId)) filter.adminId = req.query.adminId;
    else if (req.query.all !== "1") filter.adminId = req.auth.user_id;
    if (req.query.status) filter.status = str(req.query.status, 20);
    if (req.query.slug) {
      const venue = await Venue.findOne({ slug: req.query.slug }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venue = venue._id;
    }

    const [assists, total] = await Promise.all([
      VenueLeadAssist.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("venue", "name slug city")
        .populate("adminId", "name email")
        // Read-only projection of the CRM lead. Deliberately narrow: enough to
        // recognise the couple, nothing that turns this into a second CRM.
        //
        // eventDate is NESTED at qualificationData.eventDate — selecting a bare
        // "eventDate" silently returns nothing, which reads as "no date" rather
        // than as a bug. `stage` is the top-level lifecycle field; the other
        // `status` on this model belongs to callCompletion and is not it.
        .populate("enquiry", "name phone stage createdAt qualificationData.eventDate")
        .lean(),
      VenueLeadAssist.countDocuments(filter),
    ]);
    return res.status(200).json({ assists, total });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const createLeadAssist = async (req, res) => {
  try {
    const { slug, enquiryId, role, notes } = req.body;
    if (!slug || !enquiryId) return res.status(400).json({ message: "slug and enquiryId are required" });
    if (!isId(enquiryId)) return res.status(400).json({ message: "Invalid enquiryId" });

    const venue = await Venue.findOne({ slug }).select("_id name slug").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const allowed = VenueLeadAssist.schema.path("role").enumValues;
    const chosen = role || "recommending";
    if (!allowed.includes(chosen)) {
      return res.status(400).json({ message: `role must be one of ${allowed.join("|")}` });
    }

    const adminId = req.body.adminId && isId(req.body.adminId) ? req.body.adminId : req.auth.user_id;

    const existing = await VenueLeadAssist.findOne({
      adminId, enquiry: enquiryId, venue: venue._id, status: "active",
    });
    if (existing) return res.status(409).json({ message: "Already assisting on this lead for this venue", assist: existing });

    const assist = await VenueLeadAssist.create({
      venue: venue._id,
      adminId,
      enquiry: enquiryId,
      role: chosen,
      notes: str(notes, 2000),
    });
    return res.status(201).json({ assist });
  } catch (err) {
    // The partial unique index surfaces a duplicate as E11000.
    if (err && err.code === 11000) {
      return res.status(409).json({ message: "Already assisting on this lead for this venue" });
    }
    return res.status(500).json({ message: err.message });
  }
};

const updateLeadAssist = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid assist id" });
    const assist = await VenueLeadAssist.findById(req.params.id);
    if (!assist) return res.status(404).json({ message: "Assist not found" });

    if (req.body.role !== undefined) {
      const allowed = VenueLeadAssist.schema.path("role").enumValues;
      if (!allowed.includes(req.body.role)) {
        return res.status(400).json({ message: `role must be one of ${allowed.join("|")}` });
      }
      assist.role = req.body.role;
    }
    if (req.body.notes !== undefined) assist.notes = str(req.body.notes, 2000);
    if (req.body.status !== undefined) {
      if (!["active", "closed"].includes(req.body.status)) {
        return res.status(400).json({ message: "status must be active|closed" });
      }
      assist.status = req.body.status;
      assist.closedAt = req.body.status === "closed" ? new Date() : undefined;
    }
    await assist.save();
    return res.status(200).json({ assist });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const deleteLeadAssist = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid assist id" });
    const assist = await VenueLeadAssist.findByIdAndDelete(req.params.id);
    if (!assist) return res.status(404).json({ message: "Assist not found" });
    // Nothing on the CRM lead is touched — the assist is the only fact removed.
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /bulk — Track A actions across a selection ─────────────────────────
// Enrich and verify are the two Track A moves that are genuinely repetitive
// ("these forty are all missing pricing"), so they get a bulk path. Track B is
// deliberately NOT bulkable: granting partner access designates a specific
// person's phone as the login for a specific venue, and doing that forty at a
// time is exactly how the wrong people get accounts.
//
// Capability is re-checked here per action, because ONE route cannot be gated
// by a single requirePermission when it can perform either of two jobs.
const bulk = async (req, res) => {
  try {
    const { action, slugs } = req.body;
    if (!["verify", "unverify", "enrich"].includes(action)) {
      return res.status(400).json({ message: "action must be verify|unverify|enrich" });
    }
    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({ message: "slugs must be a non-empty array" });
    }
    if (slugs.length > 200) {
      return res.status(400).json({ message: "At most 200 venues per bulk action" });
    }

    const required = action === "enrich" ? "venues_enrich:edit:all" : "venues_verify:edit:all";
    const { allowed } = permissionSatisfies(await permissionsForAdmin(await AdminRepository.findById(req.auth.user_id)), required);
    if (!allowed) return res.status(403).json({ message: "Forbidden", required });

    const venues = await Venue.find({ slug: { $in: slugs } }).select("_id slug verified enrichment").lean();
    const found = new Set(venues.map((v) => v.slug));
    const missing = [...new Set(slugs)].filter((s) => !found.has(s));
    if (missing.length) return res.status(400).json({ message: "Unknown venue slug(s)", missing });

    const now = new Date();
    const actorId = req.auth.user_id;
    const notes = str(req.body.notes, 2000);

    let set;
    if (action === "enrich") {
      const completeness = req.body.completeness;
      if (completeness !== undefined) {
        const n = Number(completeness);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ message: "completeness must be a number between 0 and 100" });
        }
      }
      set = { "enrichment.lastEnrichedBy": actorId, "enrichment.lastEnrichedAt": now };
      if (completeness !== undefined) set["enrichment.completeness"] = Number(completeness);
      if (Array.isArray(req.body.missingFields)) {
        set["enrichment.missingFields"] = req.body.missingFields.map((f) => str(f, 80)).filter(Boolean).slice(0, 100);
      }
    } else {
      set = {
        "verified.isVerified": action === "verify",
        "verified.verifiedBy": actorId,
        "verified.verifiedAt": now,
        "verified.notes": notes,
      };
    }

    const ids = venues.map((v) => v._id);
    const r = await Venue.updateMany({ _id: { $in: ids } }, { $set: set });

    const actor = adminActor(req);
    logActivity(
      venues.map((v) => ({
        venue: v._id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: action === "enrich" ? "venue_enriched" : action === "verify" ? "venue_verified" : "venue_unverified",
        entity: action === "enrich" ? "enrichment" : "verification",
        new: snap({ bulk: true, notes }),
        severity: action === "enrich" ? "normal" : "high",
      }))
    );

    return res.status(200).json({ action, matched: venues.length, modified: r.modifiedCount });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── worklist ────────────────────────────────────────────────────────────────

// Monday 00:00 venue-local. Deliberately IST rather than UTC: the week is a
// human planning unit, and "Monday" has to mean Monday in Bengaluru.
function weekStartOf(instant = new Date()) {
  const dayStart = T.startOfVenueDay(instant);
  const key = T.venueDateKey(instant);
  const [y, m, d] = key.split("-").map(Number);
  // Day-of-week of the venue-local calendar date (0=Sun).
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return T.addVenueDays(dayStart, -backToMonday);
}

// Did the committed work actually happen inside the window? Derived per kind
// so progress can never drift from the venues the target points at.
async function progressFor(kind, venueIds, assignee, from, to) {
  if (!venueIds.length) return { done: 0, doneVenueIds: [] };
  if (kind === "visit") {
    const rows = await VenuePartnerVisit.find({
      venue: { $in: venueIds },
      visitedBy: assignee,
      visitedAt: { $gte: from, $lt: to },
    }).select("venue").lean();
    const ids = [...new Set(rows.map((r) => String(r.venue)))];
    return { done: ids.length, doneVenueIds: ids };
  }
  const field =
    kind === "enrich" ? "enrichment.lastEnrichedAt"
      : kind === "verify" ? "verified.verifiedAt"
        : "partner.accessGrantedAt";
  const match = { _id: { $in: venueIds }, [field]: { $gte: from, $lt: to } };
  // A verify target is only met by an actual verification, not by an unverify
  // that also stamps verifiedAt.
  if (kind === "verify") match["verified.isVerified"] = true;
  const rows = await Venue.find(match).select("_id").lean();
  const ids = rows.map((r) => String(r._id));
  return { done: ids.length, doneVenueIds: ids };
}

// ── GET /worklist — the Monday worklist ─────────────────────────────────────
// Returns the committed targets AND the specific venues behind each, because a
// target without its list is a number to feel bad about rather than work to do.
const getWorklist = async (req, res) => {
  try {
    const when = req.query.week ? new Date(req.query.week) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ message: "week must be a valid date" });
    const from = weekStartOf(when);
    const to = T.addVenueDays(from, 7);

    const filter = { weekStart: from };
    if (req.query.assignee && isId(req.query.assignee)) filter.assignee = req.query.assignee;
    else if (req.query.all !== "1") filter.assignee = req.auth.user_id;

    const targets = await VenueWorkTarget.find(filter)
      .populate("assignee", "name email")
      .populate("venues", "name slug city status entryPoint verified enrichment partner")
      .lean();

    const rows = [];
    for (const t of targets) {
      const venues = t.venues || [];
      const venueIds = venues.map((v) => v._id);
      const { done, doneVenueIds } = await progressFor(t.kind, venueIds, t.assignee._id || t.assignee, from, to);
      const doneSet = new Set(doneVenueIds);
      rows.push({
        _id: t._id,
        kind: t.kind,
        weekStart: t.weekStart,
        assignee: t.assignee,
        target: t.target || venues.length,
        done,
        notes: t.notes || "",
        // The list IS the feature — each venue carries its own track state so
        // the OS can render the row without a second round trip.
        venues: venues.map((v) => ({
          _id: v._id,
          name: v.name,
          slug: v.slug,
          city: v.city,
          status: v.status,
          entryPoint: v.entryPoint || "",
          done: doneSet.has(String(v._id)),
          ...tracks.trackSummary(v),
        })),
      });
    }

    return res.status(200).json({ weekStart: from, weekEnd: to, targets: rows });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── PUT /worklist — commit a week's set (Monday assignment) ─────────────────
const upsertWorkTarget = async (req, res) => {
  try {
    const { kind, slugs, target, notes } = req.body;
    if (!["enrich", "verify", "visit", "onboard"].includes(kind)) {
      return res.status(400).json({ message: "kind must be enrich|verify|visit|onboard" });
    }
    if (slugs !== undefined && !Array.isArray(slugs)) {
      return res.status(400).json({ message: "slugs must be an array" });
    }
    const when = req.body.week ? new Date(req.body.week) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ message: "week must be a valid date" });
    const weekStart = weekStartOf(when);

    const assignee = req.body.assignee && isId(req.body.assignee) ? req.body.assignee : req.auth.user_id;

    let venueIds;
    if (slugs !== undefined) {
      const found = await Venue.find({ slug: { $in: slugs.slice(0, 500) } }).select("_id slug").lean();
      if (found.length !== new Set(slugs).size) {
        const foundSlugs = new Set(found.map((v) => v.slug));
        const missing = [...new Set(slugs)].filter((s) => !foundSlugs.has(s));
        return res.status(400).json({ message: "Unknown venue slug(s)", missing });
      }
      venueIds = found.map((v) => v._id);
    }

    const update = { assignee, kind, weekStart, createdBy: req.auth.user_id };
    if (venueIds !== undefined) update.venues = venueIds;
    if (notes !== undefined) update.notes = str(notes, 2000);
    if (target !== undefined) {
      const n = Number(target);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "target must be a non-negative number" });
      update.target = n;
    } else if (venueIds !== undefined) {
      update.target = venueIds.length;
    }

    const doc = await VenueWorkTarget.findOneAndUpdate(
      { weekStart, assignee, kind },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate("venues", "name slug");

    return res.status(200).json({ target: doc });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: "A target for this week, assignee and kind already exists" });
    }
    return res.status(500).json({ message: err.message });
  }
};

const deleteWorkTarget = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid target id" });
    const doc = await VenueWorkTarget.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: "Target not found" });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getPartnership,
  bulk,
  setVerified,
  setEnrichment,
  grantAccess,
  setTerms,
  updateOnboarding,
  upsertOnboardingStage,
  removeOnboardingStage,
  listPartnerVisits,
  createPartnerVisit,
  updatePartnerVisit,
  deletePartnerVisit,
  listLeadAssists,
  createLeadAssist,
  updateLeadAssist,
  deleteLeadAssist,
  getWorklist,
  upsertWorkTarget,
  deleteWorkTarget,
  // exported for tests
  weekStartOf,
  partnershipView,
};

const Venue = require("../models/Venue");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueTeamActivity = require("../models/VenueTeamActivity");
const { VENUE_ROLES, roleHasCapability } = require("../utils/venueRoles");

async function resolveOwnedVenue(req, res) {
  const { slug } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

function actorId(req) {
  return String(req.venueOwner.memberId || req.venueOwner.venueOwnerId || "");
}

// Best-effort activity logging — never let a logging failure break the action.
async function logActivity(venueId, { actorId: aId = "", actorName = "", action, targetMemberId = "", detail = "" }) {
  try {
    await VenueTeamActivity.create({ venueId, actorId: aId, actorName, action, targetMemberId, detail });
  } catch (err) {
    console.error("Failed to log team activity:", err.message);
  }
}

// GET /venues/:slug/team — list members (team capability).
const listMembers = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const members = await VenueTeamMember.find({ venueId: venue._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ members, total: members.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/team — invite a member (team capability).
const inviteMember = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { name, phone, email, role } = req.body || {};
    if (!name || !phone) return res.status(400).json({ message: "Name and phone are required" });

    const finalRole = VENUE_ROLES.includes(role) ? role : "sales";
    // Only an actor with billing/owner-management (owner) can grant the owner role.
    if (finalRole === "owner" && !roleHasCapability(req.venueOwner.role, "billing")) {
      return res.status(403).json({ message: "Only the owner can grant the owner role" });
    }

    const existing = await VenueTeamMember.findOne({ venueId: venue._id, phone }).lean();
    if (existing) return res.status(400).json({ message: "A member with this phone already exists" });

    const member = await VenueTeamMember.create({
      venueId: venue._id,
      ownerId: req.venueOwner.venueOwnerId || undefined,
      name,
      phone,
      email: email || "",
      role: finalRole,
      invitedBy: req.venueOwner.memberId || req.venueOwner.venueOwnerId || undefined,
    });

    await logActivity(venue._id, {
      actorId: actorId(req),
      action: "member_invited",
      targetMemberId: String(member._id),
      detail: `Invited ${name} as ${finalRole}`,
    });

    return res.status(201).json({ member });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A member with this phone already exists" });
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/team/:memberId — update / deactivate (team capability).
const updateMember = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { memberId } = req.params;
    const member = await VenueTeamMember.findOne({ _id: memberId, venueId: venue._id });
    if (!member) return res.status(404).json({ message: "Member not found" });

    // Can't deactivate / demote yourself.
    if (String(member._id) === String(req.venueOwner.memberId)) {
      return res.status(400).json({ message: "You cannot modify your own membership" });
    }

    const { name, email, role, isActive } = req.body || {};
    const changes = [];

    if (role !== undefined) {
      if (!VENUE_ROLES.includes(role)) return res.status(400).json({ message: "Invalid role" });
      // Granting or changing the owner role requires billing/owner-management.
      if ((role === "owner" || member.role === "owner") && !roleHasCapability(req.venueOwner.role, "billing")) {
        return res.status(403).json({ message: "Only the owner can change the owner role" });
      }
      if (role !== member.role) changes.push(`role ${member.role}→${role}`);
      member.role = role;
    }
    if (typeof name === "string" && name.trim()) member.name = name.trim();
    if (typeof email === "string") member.email = email;
    if (typeof isActive === "boolean" && isActive !== member.isActive) {
      member.isActive = isActive;
      changes.push(isActive ? "reactivated" : "deactivated");
    }

    await member.save();

    await logActivity(venue._id, {
      actorId: actorId(req),
      action: isActive === false ? "member_deactivated" : role !== undefined ? "role_changed" : "member_updated",
      targetMemberId: String(member._id),
      detail: changes.join(", ") || "updated",
    });

    return res.status(200).json({ member });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/team/activity — recent team activity (team capability).
const getActivity = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const activity = await VenueTeamActivity.find({ venueId: venue._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.status(200).json({ activity, total: activity.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listMembers, inviteMember, updateMember, getActivity, logActivity };

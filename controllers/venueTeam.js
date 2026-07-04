const bcrypt = require("bcrypt");
const crypto = require("crypto");
const Venue = require("../models/Venue");
const VenueRole = require("../models/VenueRole");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueTeamActivity = require("../models/VenueTeamActivity");
const { VENUE_ROLES, roleHasCapability } = require("../utils/venueRoles");
const { ensureVenueRoles } = require("../utils/venueRbac");
const { optStr } = require("../utils/venueInput");

const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Owner-actor test (D5: owner is king). True for the real owner token and for
// members holding the legacy "owner" role or the system Owner bundle.
async function isOwnerActor(req) {
  if (!req.venueOwner.memberId) return true; // owner token
  if (req.venueOwner.role === "owner") return true;
  const roleRef = req.venueMember && req.venueMember.roleRef;
  if (!roleRef) return false;
  const role = await VenueRole.findById(roleRef).select("isSystem").lean();
  return Boolean(role && role.isSystem);
}

function generateTempPassword() {
  return crypto.randomBytes(8).toString("base64url"); // ~11 chars, URL-safe
}

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

// GET /venues/:slug/team — list members (team capability). First touch also
// seeds the RBAC v2 bundles and lazily migrates legacy-enum members onto them.
const listMembers = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { migrateLegacyMembers } = require("../utils/venueRbac");
    await migrateLegacyMembers(venue._id);
    const members = await VenueTeamMember.find({ venueId: venue._id })
      .sort({ createdAt: -1 })
      .populate("roleRef", "name capabilities isSystem isDefault")
      .lean();
    return res.status(200).json({ members, total: members.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/team — invite a member (team capability).
// RBAC v2 (D5) additions, all backward-compatible: `roleId` assigns a
// VenueRole bundle (legacy `role` enum still accepted); `email` + password
// enable email/password member login — pass `tempPassword` or omit it to get
// a server-generated one, returned ONCE in the response for the owner to
// hand over. Invites without email keep the legacy phone-OTP-only shape.
const inviteMember = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { name, phone, email, role, roleId, tempPassword, withPassword } = req.body || {};
    if (!name || !phone) return res.status(400).json({ message: "Name and phone are required" });

    const emailV = optStr(email, "email", 200);
    if (!emailV.ok) return res.status(400).json({ message: emailV.message });
    const cleanEmail = (emailV.value || "").toLowerCase();
    if (cleanEmail && !EMAIL_RE.test(cleanEmail)) return res.status(400).json({ message: "Invalid email address" });

    const finalRole = VENUE_ROLES.includes(role) ? role : "sales";
    // Only an actor with billing/owner-management (owner) can grant the owner role.
    if (finalRole === "owner" && !roleHasCapability(req.venueOwner.role, "billing")) {
      return res.status(403).json({ message: "Only the owner can grant the owner role" });
    }

    // Bundle assignment (preferred path). Granting the system Owner bundle is
    // owner-only, mirroring the legacy owner-role rule.
    let roleRefDoc = null;
    if (roleId !== undefined) {
      await ensureVenueRoles(venue._id);
      roleRefDoc = await VenueRole.findOne({ _id: roleId, venue: venue._id }).select("name isSystem").lean();
      if (!roleRefDoc) return res.status(400).json({ message: "Unknown roleId for this venue" });
      if (roleRefDoc.isSystem && !(await isOwnerActor(req))) {
        return res.status(403).json({ message: "Only the owner can grant the Owner role" });
      }
    }

    const existing = await VenueTeamMember.findOne({ venueId: venue._id, phone }).lean();
    if (existing) return res.status(400).json({ message: "A member with this phone already exists" });
    if (cleanEmail) {
      const emailTaken = await VenueTeamMember.findOne({ venueId: venue._id, email: cleanEmail }).lean();
      if (emailTaken) return res.status(400).json({ message: "A member with this email already exists" });
    }

    // Email login setup: explicit tempPassword, or withPassword:true to have
    // one generated. Either requires an email to log in with.
    let issuedPassword = "";
    if (tempPassword !== undefined || withPassword === true) {
      if (!cleanEmail) return res.status(400).json({ message: "An email is required to set a member password" });
      issuedPassword = typeof tempPassword === "string" && tempPassword.length >= 8 ? tempPassword : generateTempPassword();
      if (typeof tempPassword === "string" && tempPassword.length > 0 && tempPassword.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
    }

    const member = await VenueTeamMember.create({
      venueId: venue._id,
      ownerId: req.venueOwner.venueOwnerId || undefined,
      name,
      phone,
      email: cleanEmail,
      role: finalRole,
      roleRef: roleRefDoc ? roleRefDoc._id : undefined,
      passwordHash: issuedPassword ? await bcrypt.hash(issuedPassword, BCRYPT_ROUNDS) : "",
      invitedBy: req.venueOwner.memberId || req.venueOwner.venueOwnerId || undefined,
    });

    await logActivity(venue._id, {
      actorId: actorId(req),
      action: "member_invited",
      targetMemberId: String(member._id),
      detail: `Invited ${name} as ${roleRefDoc ? roleRefDoc.name : finalRole}`,
    });

    const out = member.toObject();
    delete out.passwordHash;
    return res.status(201).json({ member: out, ...(issuedPassword ? { tempPassword: issuedPassword } : {}) });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A member with this phone or email already exists" });
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/team/:memberId/password — owner sets/resets a member's
// password (D5: owner is king — this is an OWNER action, not a team-capability
// action; a Manager without team can't rotate credentials, and even a
// team-capability member cannot unless they hold the Owner bundle).
const setMemberPassword = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if (!(await isOwnerActor(req))) {
      return res.status(403).json({ message: "Only the owner can set member passwords" });
    }
    const member = await VenueTeamMember.findOne({ _id: req.params.memberId, venueId: venue._id });
    if (!member) return res.status(404).json({ message: "Member not found" });
    if (!member.email) return res.status(400).json({ message: "Member has no email — set an email first" });

    const { password } = req.body || {};
    const issued = typeof password === "string" && password.length > 0 ? password : generateTempPassword();
    if (issued.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    member.passwordHash = await bcrypt.hash(issued, BCRYPT_ROUNDS);
    await member.save();

    await logActivity(venue._id, {
      actorId: actorId(req),
      action: "member_password_reset",
      targetMemberId: String(member._id),
      detail: `Password reset for ${member.name}`,
    });
    // Generated passwords are returned once; caller-supplied ones are not echoed.
    return res.status(200).json({ success: true, ...(typeof password === "string" && password.length > 0 ? {} : { tempPassword: issued }) });
  } catch (err) {
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

    const { name, email, role, roleId, isActive } = req.body || {};
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
    // RBAC v2: reassign the capability bundle. Granting/removing the system
    // Owner bundle is owner-only, mirroring the legacy owner-role rule.
    if (roleId !== undefined) {
      const newRole = await VenueRole.findOne({ _id: roleId, venue: venue._id }).select("name isSystem").lean();
      if (!newRole) return res.status(400).json({ message: "Unknown roleId for this venue" });
      let currentIsSystem = false;
      if (member.roleRef) {
        const cur = await VenueRole.findById(member.roleRef).select("isSystem").lean();
        currentIsSystem = Boolean(cur && cur.isSystem);
      }
      if ((newRole.isSystem || currentIsSystem) && !(await isOwnerActor(req))) {
        return res.status(403).json({ message: "Only the owner can change the Owner role" });
      }
      if (String(member.roleRef || "") !== String(newRole._id)) changes.push(`bundle→${newRole.name}`);
      member.roleRef = newRole._id;
    }
    if (typeof name === "string" && name.trim()) member.name = name.trim();
    if (typeof email === "string") {
      const cleanEmail = email.trim().toLowerCase();
      if (cleanEmail && !EMAIL_RE.test(cleanEmail)) return res.status(400).json({ message: "Invalid email address" });
      member.email = cleanEmail;
    }
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

module.exports = { listMembers, inviteMember, updateMember, setMemberPassword, getActivity, logActivity };

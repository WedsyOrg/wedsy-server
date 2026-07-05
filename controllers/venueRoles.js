const Venue = require("../models/Venue");
const VenueRole = require("../models/VenueRole");
const VenueTeamMember = require("../models/VenueTeamMember");
const { CAPABILITIES_V2 } = require("../utils/venueRoles");
const { ensureVenueRoles, migrateLegacyMembers } = require("../utils/venueRbac");
const { reqStr } = require("../utils/venueInput");

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
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

function validCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return null;
  const cleaned = [...new Set(capabilities.map((c) => String(c).trim()))];
  if (cleaned.some((c) => !CAPABILITIES_V2.includes(c))) return null;
  return cleaned;
}

// GET /venues/:slug/roles — list bundles (team capability). First touch seeds
// the system Owner role + 4 defaults and lazily migrates legacy members.
const listRoles = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    await ensureVenueRoles(venue._id);
    await migrateLegacyMembers(venue._id);
    const roles = await VenueRole.find({ venue: venue._id }).sort({ isSystem: -1, isDefault: -1, name: 1 }).lean();
    // Member counts drive the delete guard in the UI (reassign before delete).
    const counts = await VenueTeamMember.aggregate([
      { $match: { venueId: venue._id, roleRef: { $ne: null } } },
      { $group: { _id: "$roleRef", n: { $sum: 1 } } },
    ]);
    const countByRole = new Map(counts.map((c) => [String(c._id), c.n]));
    return res.status(200).json({
      capabilities: CAPABILITIES_V2,
      roles: roles.map((r) => ({ ...r, memberCount: countByRole.get(String(r._id)) || 0 })),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/roles — create a custom bundle (team capability).
const createRole = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const nameV = reqStr((req.body || {}).name, "name", 100);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const capabilities = validCapabilities((req.body || {}).capabilities);
    if (!capabilities || capabilities.length === 0) {
      return res.status(400).json({ message: `capabilities must be a non-empty subset of: ${CAPABILITIES_V2.join(", ")}` });
    }
    await ensureVenueRoles(venue._id);
    const role = await VenueRole.create({ venue: venue._id, name: nameV.value, capabilities });
    return res.status(201).json({ role });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A role with this name already exists" });
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/roles/:roleId — rename / edit capabilities (team capability).
// The system Owner role is immutable.
const updateRole = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const role = await VenueRole.findOne({ _id: req.params.roleId, venue: venue._id });
    if (!role) return res.status(404).json({ message: "Role not found" });
    if (role.isSystem) return res.status(403).json({ message: "The Owner role cannot be edited" });

    const body = req.body || {};
    if (body.name !== undefined) {
      const nameV = reqStr(body.name, "name", 100);
      if (!nameV.ok) return res.status(400).json({ message: nameV.message });
      role.name = nameV.value;
    }
    if (body.capabilities !== undefined) {
      const capabilities = validCapabilities(body.capabilities);
      if (!capabilities || capabilities.length === 0) {
        return res.status(400).json({ message: `capabilities must be a non-empty subset of: ${CAPABILITIES_V2.join(", ")}` });
      }
      role.capabilities = capabilities;
    }
    await role.save();
    return res.status(200).json({ role });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A role with this name already exists" });
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/roles/:roleId — only when no member holds it (409:
// reassign first). System Owner role never deletable.
const deleteRole = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const role = await VenueRole.findOne({ _id: req.params.roleId, venue: venue._id });
    if (!role) return res.status(404).json({ message: "Role not found" });
    if (role.isSystem) return res.status(403).json({ message: "The Owner role cannot be deleted" });
    const members = await VenueTeamMember.countDocuments({ venueId: venue._id, roleRef: role._id });
    if (members > 0) {
      return res.status(409).json({ message: `${members} member(s) hold this role — reassign them first`, memberCount: members });
    }
    await role.deleteOne();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listRoles, createRole, updateRole, deleteRole };

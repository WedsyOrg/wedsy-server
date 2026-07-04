const VenueRole = require("../models/VenueRole");
const VenueTeamMember = require("../models/VenueTeamMember");
const {
  roleHasCapability,
  CAPABILITIES_V2,
  CAPABILITY_ALIASES,
  DEFAULT_ROLE_BUNDLES,
  LEGACY_ROLE_TO_BUNDLE,
  LEGACY_CUSTOM_BUNDLES,
} = require("./venueRoles");

// ── Lazy seeding ──
// First touch of a venue's RBAC surface creates the system Owner role and the
// four starter bundles. Seeding happens ONLY when the venue has zero roles, so
// an owner who later deletes or edits a default is never fought by re-seeding.
async function ensureVenueRoles(venueId) {
  const count = await VenueRole.countDocuments({ venue: venueId });
  if (count > 0) return;
  const docs = [
    { venue: venueId, name: "Owner", capabilities: [...CAPABILITIES_V2], isSystem: true },
    ...DEFAULT_ROLE_BUNDLES.map((b) => ({ venue: venueId, name: b.name, capabilities: b.capabilities, isDefault: true })),
  ];
  // Legacy listing-flavoured roles get capability-preserving custom bundles
  // only if the venue actually has members holding them.
  const legacyListing = await VenueTeamMember.exists({ venueId, role: { $in: ["listing_manager", "marketing"] } });
  if (legacyListing) {
    for (const b of LEGACY_CUSTOM_BUNDLES) docs.push({ venue: venueId, name: b.name, capabilities: b.capabilities });
  }
  try {
    await VenueRole.insertMany(docs, { ordered: false });
  } catch (err) {
    if (err.code !== 11000) throw err; // concurrent seed — duplicates are fine
  }
}

// ── Additive migration ──
// Members without a roleRef get one mapped from their legacy enum. The legacy
// role string is left in place as the fallback for old tokens/branches.
async function migrateLegacyMembers(venueId) {
  const unmapped = await VenueTeamMember.find({ venueId, roleRef: { $exists: false } }).select("role");
  if (unmapped.length === 0) return 0;
  await ensureVenueRoles(venueId);
  const roles = await VenueRole.find({ venue: venueId }).select("name").lean();
  const byName = new Map(roles.map((r) => [r.name, r._id]));
  let migrated = 0;
  for (const m of unmapped) {
    const bundleName = LEGACY_ROLE_TO_BUNDLE[m.role];
    const roleId = bundleName && byName.get(bundleName);
    if (!roleId) continue; // unknown legacy role — leave on legacy resolution
    await VenueTeamMember.updateOne({ _id: m._id, roleRef: { $exists: false } }, { $set: { roleRef: roleId } });
    migrated++;
  }
  return migrated;
}

function bundleGrants(capabilities, capability) {
  if (!Array.isArray(capabilities)) return false;
  return capabilities.includes(capability) || capabilities.includes(CAPABILITY_ALIASES[capability]);
}

// ── Per-request resolution ──
// Owner tokens (venueOwnerId, no memberId) always have every capability —
// owner is king (D5). Member tokens resolve through their bundle; members
// without a roleRef fall back to the legacy static map (alias-aware in both
// directions). venueOwnerAuth may stash the fresh member doc on
// req.venueMember to save a second read; otherwise we fetch it here.
async function hasCapability(reqVenueOwner, capability, venueMember) {
  if (!reqVenueOwner) return false;
  if (!reqVenueOwner.memberId) return true; // owner token

  let member = venueMember;
  if (!member || String(member._id) !== String(reqVenueOwner.memberId)) {
    member = await VenueTeamMember.findById(reqVenueOwner.memberId).select("role roleRef isActive venueId").lean();
  }
  if (!member || member.isActive === false) return false;

  if (member.roleRef) {
    const role = await VenueRole.findById(member.roleRef).select("capabilities").lean();
    if (role) return bundleGrants(role.capabilities, capability);
  }
  // Legacy fallback: static map, alias-aware.
  const legacyRole = member.role || reqVenueOwner.role;
  return (
    roleHasCapability(legacyRole, capability) ||
    (CAPABILITY_ALIASES[capability] ? roleHasCapability(legacyRole, CAPABILITY_ALIASES[capability]) : false)
  );
}

// Owner-actor test (D5/D7: owner is king). True for the real owner token and
// for members holding the legacy "owner" role or the system Owner bundle.
async function isOwnerActor(reqVenueOwner, venueMember) {
  if (!reqVenueOwner) return false;
  if (!reqVenueOwner.memberId) return true; // owner token
  if (reqVenueOwner.role === "owner") return true;
  let member = venueMember;
  if (!member || String(member._id) !== String(reqVenueOwner.memberId)) {
    member = await VenueTeamMember.findById(reqVenueOwner.memberId).select("role roleRef").lean();
  }
  if (!member) return false;
  if (member.role === "owner") return true;
  if (!member.roleRef) return false;
  const role = await VenueRole.findById(member.roleRef).select("isSystem").lean();
  return Boolean(role && role.isSystem);
}

module.exports = { ensureVenueRoles, migrateLegacyMembers, hasCapability, bundleGrants, isOwnerActor };

/**
 * utils/venueOwnerMember.js — the owner's own VenueTeamMember row.
 *
 * WHY: `assignedTo` (leads, tasks, follow-ups) is a ref to VenueTeamMember, and
 * the owner had no row — so the owner could not be assigned anything. The UI
 * papered over it by calling "You (owner)" a synonym for UNASSIGNED, which made
 * an owner's own work indistinguishable from nobody's work. This gives every
 * venue owner a real, first-class member row.
 *
 * WHAT IT IS NOT: a login identity. The row never carries an email or a
 * passwordHash, and every member login lane filters `isOwnerAccount` out
 * (collectIdentities / send-otp / member-auth / select-identity). Owner login is
 * completely unchanged: phone OTP against VenueOwner, exactly as before. One
 * owner phone therefore still yields exactly ONE identity.
 *
 * The row is created lazily and idempotently — first owner login, first touch of
 * the team surface, or first "Me" resolution, whichever comes first. Nothing
 * needs to be backfilled for the feature to work; scripts/migrate-owner-members
 * exists only to warm the rows ahead of the deploy.
 */
const VenueOwner = require("../models/VenueOwner");
const VenueRole = require("../models/VenueRole");
const VenueTeamMember = require("../models/VenueTeamMember");
const { ensureVenueRoles } = require("./venueRbac");

// The system Owner bundle for this venue (seeded on demand). Null only if the
// seed raced and lost, in which case the row falls back to the legacy "owner"
// enum — which resolves to the same all-capabilities answer.
async function systemOwnerRoleId(venueId) {
  await ensureVenueRoles(venueId);
  const role = await VenueRole.findOne({ venue: venueId, isSystem: true }).select("_id").lean();
  return role ? role._id : undefined;
}

// Fields that make the row an owner account rather than an ordinary member.
// Applied on create AND on adoption, so a self-invited row converges on the
// same shape as a freshly created one.
function ownerRowShape(owner, roleId) {
  return {
    name: owner.name,
    phone: owner.phone,
    role: "owner",
    isOwnerAccount: true,
    isActive: true,
    // Not a login identity — an adopted row's credentials are retired here.
    email: "",
    passwordHash: "",
    ...(roleId ? { roleRef: roleId } : {}),
  };
}

/**
 * Ensure the member row for ONE VenueOwner, creating or adopting as needed.
 * Returns the row's _id, or null when the owner is missing/deactivated.
 *
 * Three paths, in order:
 *   1. the row already exists → refresh name/phone if the owner renamed;
 *   2. a row already holds this owner's phone (the owner invited THEMSELVES as
 *      a member — a real thing owners did to work around having no row) → ADOPT
 *      it in place. Creating a second row would hit the unique {venueId, phone}
 *      index (E11000), and adopting also preserves every lead/task/follow-up
 *      already pointing at that id;
 *   3. otherwise create it. A concurrent create loses on the unique index and
 *      is resolved by re-reading and adopting — so two parallel logins can never
 *      leave the venue with two owner rows.
 */
async function ensureOwnerMember(venueId, venueOwnerId) {
  if (!venueId || !venueOwnerId) return null;
  const owner = await VenueOwner.findOne({ _id: venueOwnerId, venueId }).select("name phone isActive").lean();
  if (!owner || owner.isActive === false) return null;

  const existing = await VenueTeamMember.findOne({ venueId, ownerId: venueOwnerId, isOwnerAccount: true })
    .select("_id name phone")
    .lean();
  if (existing) {
    // Keep the roster honest when the owner renames or changes their number.
    if (existing.name !== owner.name || existing.phone !== owner.phone) {
      await VenueTeamMember.updateOne({ _id: existing._id }, { $set: { name: owner.name, phone: owner.phone } });
    }
    return existing._id;
  }

  const roleId = await systemOwnerRoleId(venueId);

  // Path 2 — adopt a self-invited row instead of colliding with it.
  const adopted = await VenueTeamMember.findOneAndUpdate(
    { venueId, phone: owner.phone, isOwnerAccount: { $ne: true } },
    { $set: { ownerId: venueOwnerId, ...ownerRowShape(owner, roleId) } },
    { new: true }
  )
    .select("_id")
    .lean();
  if (adopted) {
    console.log(`[venueOwnerMember] adopted existing member ${adopted._id} as the owner account for venue ${venueId}`);
    return adopted._id;
  }

  try {
    const created = await VenueTeamMember.create({
      venueId,
      ownerId: venueOwnerId,
      ...ownerRowShape(owner, roleId),
    });
    return created._id;
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Path 3's race: someone else created or adopted it a moment ago.
    const raced = await VenueTeamMember.findOne({ venueId, phone: owner.phone }).select("_id").lean();
    return raced ? raced._id : null;
  }
}

// Ensure the row for EVERY active owner of a venue. Used by the team surface and
// the migration, where there is no single authed owner to key off — a venue can
// legitimately have more than one VenueOwner.
async function ensureOwnerMembers(venueId) {
  const owners = await VenueOwner.find({ venueId, isActive: { $ne: false } }).select("_id").lean();
  const ids = [];
  for (const o of owners) {
    const id = await ensureOwnerMember(venueId, o._id);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * "Me", in the member-id space that `assignedTo` lives in.
 *
 * Member token → its own memberId. Owner token → the owner's member row id,
 * created on demand. Returns null only when the row genuinely cannot exist.
 *
 * Every assignee comparison MUST go through this. A raw
 * `req.venueOwner.memberId` is `undefined` for an owner token, which silently
 * degrades to "unassigned" — the exact bug that made an owner's own tasks and
 * follow-ups vanish from their own "My work" lists.
 */
async function resolveActorMemberId(req) {
  const auth = (req && req.venueOwner) || {};
  if (auth.memberId) return auth.memberId;
  if (!auth.venueOwnerId || !auth.venueId) return null;
  const existing = await VenueTeamMember.findOne({
    venueId: auth.venueId,
    ownerId: auth.venueOwnerId,
    isOwnerAccount: true,
  })
    .select("_id")
    .lean();
  if (existing) return existing._id;
  return ensureOwnerMember(auth.venueId, auth.venueOwnerId);
}

/**
 * Every id that means "me" for authorship comparisons (`createdBy`,
 * `completedBy`, timeline actors). That field holds an ACTOR id — a member id
 * for members, but a venueOwnerId for everything an owner did before this
 * feature existed. Matching only the new member id would hide an owner's whole
 * task history from them, so an owner token matches both.
 */
async function resolveActorIds(req) {
  const auth = (req && req.venueOwner) || {};
  if (auth.memberId) return [auth.memberId];
  const ids = [];
  const memberId = await resolveActorMemberId(req);
  if (memberId) ids.push(memberId);
  if (auth.venueOwnerId) ids.push(auth.venueOwnerId);
  return ids;
}

module.exports = { ensureOwnerMember, ensureOwnerMembers, resolveActorMemberId, resolveActorIds };

/* FAMILY SHARING (§ 05.5, § 06.4) — "Google-Doc-style sharing": one of
 * seventeen relations, six sections, three levels.
 *
 * ── WHAT THIS SERVICE IS ─────────────────────────────────────────────────
 * The WRITE side of the document middlewares/coupleAuth reads on every single
 * couple-app request. § 06.4: "Enforce SharedMember.access server-side on
 * every endpoint. Hiding UI is a convenience, not a control." Everything the
 * You & your team screen draws is a picture of what is stored here; the
 * control is the gate on each route.
 *
 * ── WHY MEMBERS MANAGEMENT IS PARTNER-ONLY, STRUCTURALLY ─────────────────
 * The same argument as payouts. "members" is not one of the six grantable
 * sections in utils/coupleEnums.SECTION, SharedMember.access has no key for
 * it, and CouplePeopleRules.accessMapFrom emits exactly those six keys and no
 * others — so a member cannot be granted the right to invite another member,
 * escalate their own access, or revoke the person who invited them. It is not
 * a check a route could forget; there is nowhere to write the permission.
 */

const SharedMember = require("../models/SharedMember");
const activityService = require("./CoupleActivityService");
const rsvpService = require("./CoupleRsvpService");
const rules = require("./CouplePeopleRules");
const { SECTION } = require("../utils/coupleEnums");

const fail = (status, code, message, extra) =>
  Object.assign(new Error(message), { status, code, extra: extra || null });

const note = (couple, { action, member, summary }) => {
  const actor = rules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "member",
    objectId: member && member._id,
    summary,
  });
};

/** "the guest list and tasks" — what changed, in the couple's own words. */
const grantedList = (access) => {
  const granted = SECTION.filter((section) => access && access[section] && access[section] !== "none");
  if (!granted.length) return "nothing yet";
  if (granted.length === SECTION.length) return "everything";
  return granted.join(", ");
};

/**
 * GET /wedding/:id/members
 *
 * Revoked members are not on this list. Removal is a stamp rather than a
 * delete (their Activity rows still name them), but a revoked person is out —
 * on this screen and, immediately, on every gate.
 */
const list = async (couple) => {
  const rows = await SharedMember.find({ weddingId: couple.weddingId, revokedAt: null })
    .sort({ createdAt: 1 })
    .lean();
  // `inviteTokenHash` is select:false on the model — the one-time credential in
  // the invite link never leaves the server, hashed or not.
  return rows.map(rules.shapeMember);
};

/** POST /wedding/:id/members — { name, relation, access } */
const create = async (couple, body) => {
  const { fields, errors } = rules.memberFields(body);
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  // One person, one row. A second invitation to the same number would give the
  // couple two access maps for one relative and no way to tell which is live.
  const phoneNormalised = fields.phone ? rsvpService.normalise(fields.phone) : null;
  if (phoneNormalised) {
    const existing = await SharedMember.findOne({
      weddingId: couple.weddingId,
      phoneNormalised,
      revokedAt: null,
    }).lean();
    if (existing) {
      throw fail(409, "duplicate_member", `${existing.name || "They"} already has access to this wedding.`, {
        memberId: String(existing._id),
      });
    }
  }

  const member = await SharedMember.create({
    ...fields,
    weddingId: couple.weddingId,
    phoneNormalised: phoneNormalised || "",
    // NOT ACCEPTED, AND NOT BOUND TO AN ACCOUNT. `user` stays null until they
    // open the invite and their number resolves to a User — the membership
    // test in middlewares/coupleAuth is `user`, never `phone`, so an invitation
    // that was sent and not opened is not access. There is no accept endpoint
    // in this milestone; see docs/couple-app-api.md § People.
    user: null,
    acceptedAt: null,
    invitedAt: new Date(),
    invitedBy: couple.userId,
  });

  // NOTIFICATION — TRIGGERS ONLY, and none is added here.
  // Inviting somebody obviously wants one: trigger `couple_member_invite`,
  // carrying the invite link, through services/NotificationService.js —
  // WhatsApp via the Meta Cloud API, never Aisensy — after reading the
  // Notification System spec in Notion. The one-time token that link needs
  // (SharedMember.inviteTokenHash) is deliberately NOT minted here: a
  // credential with nothing to deliver it is a credential nobody revokes.

  await note(couple, {
    action: "member.invited",
    member,
    summary: `invited ${member.name} (${member.relation}) to help with ${grantedList(member.access)}`,
  });

  return rules.shapeMember(member.toObject ? member.toObject() : member);
};

/** PATCH /members/:id — name, relation, and the six-section access map. */
const update = async (couple, member, body) => {
  const { fields, errors } = rules.memberFields(body, { partial: true });
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  const patch = { ...fields };
  if (Object.prototype.hasOwnProperty.call(fields, "phone")) {
    patch.phoneNormalised = rsvpService.normalise(fields.phone) || "";
  }

  const saved = await SharedMember.findOneAndUpdate(
    { _id: member._id, weddingId: couple.weddingId, revokedAt: null },
    { $set: patch },
    { new: true }
  ).lean();
  if (!saved) throw fail(404, "not_found", "We could not find that person on your wedding.");

  // A change to who can see what is exactly the kind of thing the other
  // partner should find in the digest.
  if (patch.access) {
    await note(couple, {
      action: "member.access",
      member: saved,
      summary: `changed what ${saved.name} can see — now ${grantedList(saved.access)}`,
    });
  }

  return rules.shapeMember(saved);
};

/**
 * DELETE /members/:id — REVOKE, never a hard delete.
 *
 * Their Activity rows still name them, so the feed does not develop holes; and
 * CouplePermissions.isActiveMember reads `revokedAt`, so the next request they
 * make is refused. Immediately, not at the next login.
 */
const remove = async (couple, member) => {
  const saved = await SharedMember.findOneAndUpdate(
    { _id: member._id, weddingId: couple.weddingId },
    { $set: { revokedAt: new Date() } },
    { new: true }
  ).lean();
  if (!saved) throw fail(404, "not_found", "We could not find that person on your wedding.");
  await note(couple, {
    action: "member.removed",
    member: saved,
    summary: `removed ${saved.name}'s access to the wedding`,
  });
  return { ok: true, id: String(saved._id) };
};

module.exports = { list, create, update, remove, grantedList };

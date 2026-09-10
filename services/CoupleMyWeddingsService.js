/**
 * WHICH WEDDING AM I LOOKING AT?
 *
 * Every other read in this API takes the wedding from the path. This is the
 * one that answers the question before it: the app opens, the couple is signed
 * in, and nothing yet says which Event is theirs.
 *
 * Two ways a person is on a wedding, and both count (they are the same two
 * middlewares/coupleAuth.resolveMembership uses — this must not become a
 * second definition of membership):
 *   · a PARTNER — Event.user, or Event.coupleApp.partners[].user
 *   · an active SHARED MEMBER — invited, accepted, not revoked
 *
 * Ordering, because a couple can have more than one Event: the wedding still
 * ahead of them and soonest comes first, then past weddings most recent first.
 * A person planning a wedding in December and one that happened last March
 * wants December.
 */
const Event = require("../models/Event");
const SharedMember = require("../models/SharedMember");
const permissions = require("./CouplePermissions");

const dayOf = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** A row the app can render in a switcher, and nothing the person may not see. */
const shape = (event, role, now) => {
  const date = dayOf(event.eventDate);
  const partners = (event.coupleApp && event.coupleApp.partners) || [];
  const names = partners.map((p) => p && p.name).filter(Boolean);
  return {
    id: String(event._id),
    role,
    name:
      event.name ||
      (names.length ? names.join(" & ") : [event.brideName, event.groomName].filter(Boolean).join(" & ")) ||
      "Your wedding",
    date: event.eventDate || null,
    city: (event.coupleApp && event.coupleApp.city) || "",
    upcoming: Boolean(date && date >= now),
  };
};

/**
 * @returns {{ weddingId: string|null, weddings: object[] }}
 *   `weddingId` is the one to open. Null when this person is not on any
 *   wedding yet — which is a real state (a fresh account), not an error, and
 *   the app renders a welcome rather than a failure.
 */
const listForPerson = async (userId, now = new Date()) => {
  const asPartner = await Event.find(
    { $or: [{ user: userId }, { "coupleApp.partners.user": userId }] },
    { name: 1, brideName: 1, groomName: 1, eventDate: 1, "coupleApp.partners": 1, "coupleApp.city": 1 }
  ).lean();

  const memberships = await SharedMember.find({ user: userId }).lean();
  const sharedIds = memberships
    .filter((member) => permissions.isActiveMember(member))
    .map((member) => String(member.weddingId));

  const partnerIds = new Set(asPartner.map((event) => String(event._id)));
  const extraIds = sharedIds.filter((id) => !partnerIds.has(id));

  const asMember = extraIds.length
    ? await Event.find(
        { _id: { $in: extraIds } },
        { name: 1, brideName: 1, groomName: 1, eventDate: 1, "coupleApp.partners": 1, "coupleApp.city": 1 }
      ).lean()
    : [];

  const rows = asPartner
    .map((event) => shape(event, "partner", now))
    .concat(asMember.map((event) => shape(event, "member", now)));

  rows.sort((a, b) => {
    if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
    const da = dayOf(a.date);
    const db = dayOf(b.date);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    // Soonest first among the upcoming; most recent first among the past.
    return a.upcoming ? da - db : db - da;
  });

  return { weddingId: rows.length ? rows[0].id : null, weddings: rows };
};

module.exports = { listForPerson };

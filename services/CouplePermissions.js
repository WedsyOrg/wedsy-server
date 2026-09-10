/* COUPLE-APP PERMISSIONS — § 06.4, as PURE FUNCTIONS over plain documents.
 *
 * "Enforce SharedMember.access server-side on every endpoint. Hiding UI is a
 * convenience, not a control."
 *
 * Nothing in this file touches mongoose, express or the clock. It takes a
 * resolved caller and answers a question, so the matrix can be unit-tested
 * exhaustively with no database (tests/couple-permissions.test.js) and the
 * middleware in middlewares/coupleAuth.js is left with nothing to decide.
 *
 * ── THE ONE STRUCTURAL RULE ────────────────────────────────────────────────
 * § 06.4: "`edit` on payments never implies the ability to initiate a payout."
 *
 * That is not enforced here by a check that could be forgotten at a call site.
 * It is enforced by there being NO WAY TO EXPRESS IT: the grantable sections
 * are exactly the six below, "payouts" is not one of them, SharedMember.access
 * has no seventh key to set, and canInitiatePayout() never reads `access` at
 * all — it reads whether the caller IS one of the two people getting married.
 * A shared member with every section at "edit" still cannot move money, and no
 * configuration of the document can change that.
 */

const { SECTION, ACCESS_LEVEL } = require("../utils/coupleEnums");

// none < view < edit. Rank, not equality: an endpoint asks for the level it
// needs and anything above it passes.
const RANK = { none: 0, view: 1, edit: 2 };

const rank = (level) => RANK[level] || 0;

/** Is this a section the couple can actually share? Unknown ⇒ NO. */
const isSection = (section) => SECTION.indexOf(section) !== -1;

/** Is this a level a member can actually be granted? Unknown ⇒ NO. */
const isLevel = (level) => ACCESS_LEVEL.indexOf(level) !== -1;

/**
 * The caller, as the couple app understands them.
 *
 * @typedef  {object} Couple
 * @property {string} userId    the User._id behind the token
 * @property {string} weddingId the Event._id the route named
 * @property {"partner"|"member"} role
 * @property {object} [member]  the SharedMember document, for role "member"
 */

/** Either of the two people getting married. Both partners are full. */
const isPartner = (couple) => Boolean(couple) && couple.role === "partner";

/**
 * An accepted, un-revoked shared member. An invitation that was sent and never
 * opened is not access, and neither is one that was taken away.
 */
const isActiveMember = (member) =>
  Boolean(member) && Boolean(member.acceptedAt) && !member.revokedAt;

/** What level does this caller hold in this section? */
const levelFor = (couple, section) => {
  if (!isSection(section)) return "none";      // fail closed on a typo'd section
  if (isPartner(couple)) return "edit";        // both partners are full
  if (!couple || couple.role !== "member") return "none";
  if (!isActiveMember(couple.member)) return "none";
  const access = couple.member.access || {};
  const level = access[section];
  return isLevel(level) ? level : "none";
};

/** May this caller do `level` in `section`? */
const can = (couple, section, level) => {
  if (!isSection(section) || !isLevel(level) || level === "none") return false;
  return rank(levelFor(couple, section)) >= rank(level);
};

/**
 * MAY THIS CALLER MOVE MONEY OUT?
 *
 * The wallet claim and the pay flow. Deliberately takes no section and reads no
 * access map — see the header. Only a partner, ever.
 */
const canInitiatePayout = (couple) => isPartner(couple);

/**
 * The refusal body, shaped so the client can render it.
 *
 * wedsy-user's lib/plan/api.js read() distinguishes three outcomes: 401/403 is
 * "the server refused, never substitute the seed", 4xx/5xx is "the server
 * broke", 404 is "not built yet". So a refusal must be a 403 with a body — and
 * `section`/`required` are in it so the screen can say WHICH door is shut
 * rather than showing a blank wedding.
 */
const denial = (section, required, held) => ({
  error: "forbidden",
  section: section || null,
  required: required || null,
  held: held || "none",
  message: section
    ? `You do not have access to ${section} on this wedding.`
    : "You do not have access to this wedding.",
});

/** The payout refusal. Distinct `error` so the client can word it properly. */
const payoutDenial = () => ({
  error: "forbidden_payout",
  section: "payments",
  message:
    "Only the couple can move money. A shared family member can see and " +
    "annotate payments, but cannot pay or claim.",
});

/**
 * The whole matrix for one caller, for GET /wedding/:id — so the client can
 * render the right nav without ever being the thing that decides.
 */
const accessMap = (couple) => {
  const map = {};
  SECTION.forEach((section) => {
    map[section] = levelFor(couple, section);
  });
  return map;
};

module.exports = {
  SECTIONS: SECTION,
  RANK,
  rank,
  isSection,
  isLevel,
  isPartner,
  isActiveMember,
  levelFor,
  can,
  canInitiatePayout,
  denial,
  payoutDenial,
  accessMap,
};

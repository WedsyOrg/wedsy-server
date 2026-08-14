/**
 * utils/venueEventType.js — what KIND of event a lead is, and the small set of
 * things that legitimately differ because of it.
 *
 * THE PRODUCT IS NOT FORKED. A corporate offsite and a wedding share almost
 * everything that matters: dates, contention, money, follow-ups, tasks,
 * contacts, bookings, scoping, the day view, the demand map. Exactly three
 * things are genuinely wedding-shaped — the function vocabulary, the muhurat
 * advice, and what to call the lead — and this file is the whole list. Anything
 * that starts branching on eventType outside here is a bug: it means a
 * behaviour was duplicated instead of shared.
 *
 * DEFAULT IS `social`, and that is a business fact, not a coin toss. Weddings
 * are what these venues sell; every existing row is one, and a default of
 * anything else would silently re-label the entire book.
 *
 * ── THE BLACKOUT INVERSION, which is the point of the whole slice ────────────
 * A blackout season is a strong NEGATIVE signal for a wedding — almost nobody
 * marries during Chaturmas. For a corporate booking it is the exact opposite:
 * the venue is empty, the rate card has room, and a conference does not care
 * what the panchang says. The same stored fact therefore has to be READ in two
 * directions, which is why the note composer asks this file rather than
 * assuming. Suppressing the blackout for corporate would have been the easy
 * wrong answer: it would hide the single best reason to chase the lead.
 */

const EVENT_TYPES = ["social", "corporate"];
const DEFAULT_EVENT_TYPE = "social";

/** Coerce anything to a known type. Unknown input falls back to the default. */
function cleanEventType(v) {
  return EVENT_TYPES.includes(v) ? v : DEFAULT_EVENT_TYPE;
}

function isCorporate(eventType) {
  return cleanEventType(eventType) === "corporate";
}

// ── function vocabulary ─────────────────────────────────────────────────────
// Social keeps the existing wedding list untouched — renaming it would rewrite
// every stored function on every existing lead.
//
// Corporate is a generic SESSION vocabulary. The four chosen (conference,
// dinner, cocktail, ceremony) cover what a venue actually blocks a space for on
// a corporate booking: the working session, the sit-down meal, the drinks
// reception, and the awards/launch moment. `ceremony` is deliberately the
// neutral word rather than "awards" or "launch" — it covers both without
// inventing a taxonomy nobody asked for. `custom` carries anything else, the
// same escape hatch the social list has.
const FUNCTION_VOCABULARY = {
  social: ["mehendi", "haldi", "sangeet", "wedding", "reception", "custom"],
  corporate: ["conference", "dinner", "cocktail", "ceremony", "custom"],
};

/** Every function name that may be STORED, across both types. */
const ALL_FUNCTION_NAMES = [
  ...new Set([...FUNCTION_VOCABULARY.social, ...FUNCTION_VOCABULARY.corporate]),
];

function functionVocabulary(eventType) {
  return FUNCTION_VOCABULARY[cleanEventType(eventType)];
}

/**
 * Is this function name valid for this type?
 *
 * Enforced on WRITE only. A lead switched from social to corporate keeps its
 * mehendi row until someone edits it — silently deleting a stored function
 * because a dropdown changed would destroy real data over a mislabelled type.
 */
function functionAllowed(eventType, name) {
  return functionVocabulary(eventType).includes(name);
}

// ── contact relations ───────────────────────────────────────────────────────
// The people around a wedding and the people around a corporate booking are
// genuinely different roles, so the vocabulary is keyed off the type. `other`
// is in both because it always has to be.
const RELATION_VOCABULARY = {
  social: [
    "bride",
    "groom",
    "brides_father",
    "brides_mother",
    "grooms_father",
    "grooms_mother",
    "sibling",
    "planner",
    "other",
  ],
  corporate: ["main_contact", "hr_admin", "finance", "event_manager", "vendor", "other"],
};

const ALL_RELATIONS = [
  ...new Set([...RELATION_VOCABULARY.social, ...RELATION_VOCABULARY.corporate]),
];

function relationVocabulary(eventType) {
  return RELATION_VOCABULARY[cleanEventType(eventType)];
}

/**
 * Same rule as functions: a relation is validated against the type on write,
 * but an already-stored relation is never destroyed by a type change.
 */
function relationAllowed(eventType, relation) {
  return relationVocabulary(eventType).includes(relation);
}

const RELATION_LABEL = {
  bride: "Bride",
  groom: "Groom",
  brides_father: "Bride's father",
  brides_mother: "Bride's mother",
  grooms_father: "Groom's father",
  grooms_mother: "Groom's mother",
  sibling: "Sibling",
  planner: "Planner",
  main_contact: "Main contact",
  hr_admin: "HR / admin",
  finance: "Finance",
  event_manager: "Event manager",
  vendor: "Vendor",
  other: "Other",
};

// ── labels ──────────────────────────────────────────────────────────────────
// "Couple name" on a conference booking is not a cosmetic wart; it tells the
// person filling the form that this product was not built for what they are
// doing. One word, and it stops being wrong.
const NAME_LABEL = { social: "Couple / lead name", corporate: "Company / event name" };
const TYPE_LABEL = { social: "Social", corporate: "Corporate" };

function nameLabel(eventType) {
  return NAME_LABEL[cleanEventType(eventType)];
}

// ── the wedding-specific advice layer ───────────────────────────────────────

/**
 * Does muhurat/auspicious advice mean anything for this lead?
 *
 * No for corporate. A conference is not scheduled off a panchang, and telling
 * an owner a corporate date is "a major muhurat — expect competition" is worse
 * than silence: it is confidently wrong about who they are competing with.
 */
function showsAuspicious(eventType) {
  return !isCorporate(eventType);
}

/**
 * How a BLACKOUT period should be read for this lead.
 *
 * "negative" — weddings stop; few enquiries will come; close it or repurpose it.
 * "positive" — the wedding season is shut, so the venue is empty and this
 *              booking is exactly what fills it. Same stored fact, opposite
 *              business meaning, and the corporate side is the more actionable
 *              of the two.
 */
function blackoutSense(eventType) {
  return isCorporate(eventType) ? "positive" : "negative";
}

module.exports = {
  EVENT_TYPES,
  DEFAULT_EVENT_TYPE,
  cleanEventType,
  isCorporate,
  FUNCTION_VOCABULARY,
  ALL_FUNCTION_NAMES,
  functionVocabulary,
  functionAllowed,
  RELATION_VOCABULARY,
  ALL_RELATIONS,
  RELATION_LABEL,
  relationVocabulary,
  relationAllowed,
  NAME_LABEL,
  TYPE_LABEL,
  nameLabel,
  showsAuspicious,
  blackoutSense,
};

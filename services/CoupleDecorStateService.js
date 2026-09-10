/* THE FIVE-STATE DÉCOR JOURNEY (§ 3.2.2, § 06.1 DecorState) — and the one
 * enum value the foundation left open.
 *
 *     none · drafted · needs_input · priced · finalised
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 * CoupleWeddingService.decorStateOf already derives FOUR of the five from the
 * Event day itself, and says so in as many words:
 *
 *     "needs_input is NOT derivable: it means a human on the décor team is
 *      waiting on the couple for a direction, and nothing on the Event records
 *      that yet. It is listed in docs/couple-app-api.md as the one enum value
 *      the décor endpoints must supply when they land."
 *
 * This is those endpoints. It does NOT re-derive the other four: it CALLS
 * decorStateOf for the base state and lays one overlay on top, so there is
 * still exactly one place that decides whether a day is drafted, priced or
 * finalised. A second copy of that ladder is how the Planner and Home start
 * telling a couple two different things about the same day.
 *
 * ── WHAT "NEEDS INPUT" MEANS ───────────────────────────────────────────────
 * "The team cannot move until you answer." It is raised three ways, and the
 * first is the only one that is a stored fact:
 *
 *   1. THE TEAM ASKED. Event.coupleApp.decor.days[].needsInput — the additive
 *      flag this milestone added to the model, set by the décor team when they
 *      are genuinely waiting (a palette, a size, a yes to a substitution). It
 *      is a fact about a conversation and no amount of reading the day's
 *      contents can recover it, which is exactly why it is stored.
 *
 *   2. PRICED, AND NOBODY HAS CHOSEN. Comparable tiers are in front of the
 *      couple and the tier is still null (§ 3.2.2 state 4, "compare & choose").
 *      The team is waiting; Home already renders this as a decision card.
 *
 *   3. DRAFTED, AND NOTHING HEARTED FOR THAT FUNCTION. Looks have been
 *      presented and the couple has loved none of them (§ 3.2.2 state 2 → 3,
 *      Home's "No palette · Pick"). Nothing can be priced until they do.
 *
 * ── WHAT IT NEVER OVERRIDES ────────────────────────────────────────────────
 * `finalised`. The finalise is irreversible (§ 06.2) and terminal (§ 06.1); a
 * locked day is not waiting on anybody, and a stale flag left on it must not
 * unlock the ceremony's copy. `none` is not overridden either: a day with
 * nothing drawn on it is not waiting on the couple, it is waiting on the team.
 *
 * PURE. No mongoose, no clock, no express. Plain documents in, an enum out.
 */

const CoupleWeddingService = require("./CoupleWeddingService");
const { DECOR_STATE } = require("../utils/coupleEnums");

/** The couple's per-day row, or an empty one. Never null — callers read fields. */
const dayStateOf = (coupleDecor, dayId) => {
  const rows = (coupleDecor && coupleDecor.days) || [];
  const key = String(dayId || "");
  return rows.find((row) => row && String(row.dayId) === key) || {};
};

/** Has this day's décor team raised a question the couple has not answered? */
const teamIsWaiting = (coupleDecor, dayId) => Boolean(dayStateOf(coupleDecor, dayId).needsInput);

/**
 * Has the couple hearted anything for this function?
 *
 * Hearts carry the function key when the client sent one. A heart with NO
 * event key counts for every day — a couple who loved a look without saying
 * which day it is for has still expressed a direction, and reading that as
 * "they have chosen nothing" would nag them about a decision they made.
 */
const heartedFor = (coupleDecor, eventKey) => {
  const hearts = (coupleDecor && coupleDecor.hearts) || [];
  const key = String(eventKey || "");
  return hearts.some((heart) => heart && (!heart.event || String(heart.event) === key));
};

/** Which tier applies to this day — its own, else the wedding-wide choice. */
const tierFor = (coupleDecor, dayId) =>
  dayStateOf(coupleDecor, dayId).tier || (coupleDecor && coupleDecor.tier) || "";

/**
 * The state of ONE day.
 *
 * @param {object} day         an Event.eventDays[] subdocument (plain)
 * @param {object} coupleDecor Event.coupleApp.decor (plain), or absent
 * @param {string} [eventKey]  the day's function key, when the caller has it
 * @returns {"none"|"drafted"|"needs_input"|"priced"|"finalised"}
 */
const stateOf = (day, coupleDecor, eventKey) => {
  // The other four are decorStateOf's, called and not copied.
  const base = CoupleWeddingService.decorStateOf(day);
  if (base === "finalised" || base === "none") return base;

  const dayId = day && day._id ? String(day._id) : "";
  const key = eventKey || CoupleWeddingService.dayKey(day && day.name);

  if (teamIsWaiting(coupleDecor, dayId)) return "needs_input";
  if (base === "priced") return tierFor(coupleDecor, dayId) ? "priced" : "needs_input";
  // base === "drafted"
  return heartedFor(coupleDecor, key) ? "drafted" : "needs_input";
};

/**
 * Why a day is where it is, in the couple's own words, so the screen can say
 * something specific instead of rendering a status chip nobody can act on.
 * Empty string when there is nothing to say — never invented copy.
 */
const reasonFor = (day, coupleDecor, eventKey) => {
  const state = stateOf(day, coupleDecor, eventKey);
  if (state !== "needs_input") return "";
  const dayId = day && day._id ? String(day._id) : "";
  const row = dayStateOf(coupleDecor, dayId);
  if (row.needsInput) return row.needsInputNote || "Your décor team is waiting on you.";
  if (CoupleWeddingService.decorStateOf(day) === "priced") {
    return "Priced and waiting on you — compare the tiers and choose one.";
  }
  return "Nothing hearted yet for this day, so there is nothing to price.";
};

/**
 * The whole journey's state — what `GET /wedding/:id/decor` puts in `state`
 * and what the client's `ui.dxState` is seeded from (§ 3.2.2).
 *
 *   holding     the team has begun and there is nothing to look at yet
 *   presented   looks are up, nothing hearted
 *   selections  hearted, nothing priced
 *   drafts      priced, waiting on a tier
 *   finalised   locked in
 *
 * These five are the CLIENT's vocabulary and are deliberately not the same
 * list as DecorState — DecorState is per-day, this is the journey. Mapping
 * them in one function is what stops the two vocabularies from being mixed
 * halfway down a controller.
 */
const journeyState = (days, coupleDecor) => {
  const rows = Array.isArray(days) ? days : [];
  if (!rows.length) return "holding";
  const states = rows.map((row) => row.decorStatus);
  if (states.length && states.every((state) => state === "finalised")) return "finalised";
  if (states.some((state) => state === "priced" || state === "finalised")) return "drafts";
  const hearts = (coupleDecor && coupleDecor.hearts) || [];
  if (hearts.length) return "selections";
  if (states.some((state) => state !== "none")) return "presented";
  return "holding";
};

/** Guard for anything that comes back out of this file. */
const isDecorState = (state) => DECOR_STATE.indexOf(state) !== -1;

module.exports = {
  stateOf,
  reasonFor,
  journeyState,
  dayStateOf,
  teamIsWaiting,
  heartedFor,
  tierFor,
  isDecorState,
};

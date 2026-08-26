/**
 * utils/venueRoomSetup.js — which step of first-run setup a venue is on.
 *
 * ── THE STEP IS DERIVED, NOT STORED ─────────────────────────────────────────
 * Research on this was unambiguous: every serious PMS ships a sequential setup,
 * and nobody finishes it in one sitting, so it has to be resumable. The cheapest
 * resumable thing is one with almost no state — the step is a function of what
 * the owner has actually built, so closing the browser and coming back next week
 * lands on the same step by construction, and there is no progress counter to
 * disagree with the data.
 *
 * The ORDER is not arbitrary either: the shape before the types before the
 * rooms, because a room needs somewhere to be and something to be, and a rate
 * belongs to a type rather than to a room. Getting the rooms right before the
 * rates is the whole reason rates live on the type.
 *
 * Two things genuinely cannot be derived, and Venue.roomSetup holds exactly
 * those — see the model.
 */

const { distinctFloorCount } = require("./venueRoomLayout");

const STEPS = ["shape", "types", "rooms"];

/**
 * @returns {{step: "shape"|"types"|"rooms"|"done", done: boolean, finished: boolean,
 *            completed: string[], reason: string}}
 */
/**
 * ── TWO QUESTIONS THAT WERE ONE FIELD, AND THAT WAS THE BUG ─────────────────
 *
 *   finished  Has the owner SAID they are finished?  → completedAt, only ever.
 *   done      Should first-run setup be OFFERED?     → finished, or rooms exist.
 *
 * `done` conflated them. It returned true the moment ONE room existed, and the
 * wizard read it as "the rooms step is over" — so an owner adding rooms was
 * thrown out of the step by their own first room. Ten to Ground, then ten to
 * First, is the rooms-step version of "build two blocks", and it was the same
 * bug ROOMS 3 fixed one step earlier.
 *
 * They are genuinely different questions:
 *
 *   · A property with 40 rooms should not be walked through first-run setup —
 *     that is `done`, and it is a suppression, not an achievement.
 *   · Whether the owner has finished ADDING rooms is not visible in the data at
 *     all. One room and forty look identical to a derivation; only the owner
 *     knows which of them is the last. That is `finished`, and it cannot be
 *     computed from rooms.length, from every floor holding at least one room,
 *     or from any other signal — all of those are a derived value written as
 *     though typed.
 *
 * `step` is the RESUME POINT and nothing else. It stays "rooms" while rooms
 * exist and the owner has not said they are done, because that is where they
 * would want to come back to.
 */
function deriveStep(venue) {
  const v = venue || {};
  const setup = v.roomSetup || {};
  const blocks = (v.blocks || []).length;
  const types = (v.roomTypes || []).length;
  const rooms = (v.rooms || []).length;

  // The ONLY thing that means the owner has finished. Set by an explicit
  // action — POST /room-setup/complete — and by nothing else.
  const finished = Boolean(setup.completedAt);

  if (finished) {
    return { step: "done", done: true, finished: true, completed: STEPS.slice(), reason: "completed" };
  }

  const completed = [];
  // A skip counts as completing the step. "One building, one floor" leaves no
  // blocks, which is byte-identical to never having done it.
  if (blocks > 0 || setup.shapeSkipped) completed.push("shape");
  if (types > 0) completed.push("types");
  // THE ROOMS STEP IS NEVER IN HERE BY DERIVATION. It is completed by the owner
  // saying so, which is the `finished` branch above.

  if (!completed.includes("shape")) {
    return { step: "shape", done: false, finished: false, completed, reason: "no_blocks" };
  }
  if (!completed.includes("types")) {
    return { step: "types", done: false, finished: false, completed, reason: "no_types" };
  }
  // Rooms exist but the owner has not said they are done: the wizard is not
  // OFFERED unprompted any more (`done`), because a property with rooms is not
  // a first-run property — but the resume point is still the rooms step, and
  // the step itself is not complete.
  return {
    step: "rooms",
    done: rooms > 0,
    finished: false,
    completed,
    reason: rooms > 0 ? "rooms_exist" : "no_rooms",
  };
}

/** What the wizard shows about itself, without leaking the whole venue. */
function setupState(venue) {
  const v = venue || {};
  const d = deriveStep(v);
  const setup = v.roomSetup || {};
  return {
    ...d,
    steps: STEPS,
    shapeSkipped: Boolean(setup.shapeSkipped),
    dismissedAt: setup.dismissedAt || null,
    completedAt: setup.completedAt || null,
    counts: {
      blocks: (v.blocks || []).length,
      // Storeys, from the ONE implementation in venueRoomLayout. This line had
      // its own copy of the pair-summing arithmetic, so the wizard and the
      // layout legend could report different floor counts for the same venue.
      floors: distinctFloorCount(v),
      types: (v.roomTypes || []).length,
      rooms: (v.rooms || []).length,
      amenities: (v.roomAmenities || []).length,
    },
  };
}

module.exports = { STEPS, deriveStep, setupState };

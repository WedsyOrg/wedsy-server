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
 * @returns {{step: "shape"|"types"|"rooms"|"done", done: boolean, completed: string[], reason: string}}
 */
function deriveStep(venue) {
  const v = venue || {};
  const setup = v.roomSetup || {};
  const blocks = (v.blocks || []).length;
  const types = (v.roomTypes || []).length;
  const rooms = (v.rooms || []).length;

  // ── DONE, AND STAYING DONE ────────────────────────────────────────────────
  // Rooms existing is enough to hide the wizard. completedAt is what stops it
  // COMING BACK if an owner later removes every room — being walked through
  // first-run setup again on a property you have run for a year is worse than
  // an empty list.
  if (setup.completedAt || rooms > 0) {
    return { step: "done", done: true, completed: STEPS.slice(), reason: rooms > 0 ? "rooms_exist" : "completed" };
  }

  const completed = [];
  // A skip counts as completing the step. "One building, one floor" leaves no
  // blocks, which is byte-identical to never having done it.
  if (blocks > 0 || setup.shapeSkipped) completed.push("shape");
  if (types > 0) completed.push("types");

  if (!completed.includes("shape")) {
    return { step: "shape", done: false, completed, reason: "no_blocks" };
  }
  if (!completed.includes("types")) {
    return { step: "types", done: false, completed, reason: "no_types" };
  }
  return { step: "rooms", done: false, completed, reason: "no_rooms" };
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

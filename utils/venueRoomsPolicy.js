/**
 * utils/venueRoomsPolicy.js — how a venue sells its rooms, and what that costs
 * on one booking.
 *
 * ── THE ONE PLACE THE ROOMS ARITHMETIC LIVES ────────────────────────────────
 * The booking wizard, the confirmation document, the invoice and the statement
 * all call quoteRooms(). None of them computes a room charge for itself. That
 * is the same rule Build B established for payments — one derivation — applied
 * one level up, and it is why the sentence an owner reads in the wizard is
 * character-for-character the sentence the confirmation PDF prints.
 *
 * ── AND IT IS COMPUTED ONCE, THEN STORED ────────────────────────────────────
 * quoteRooms is called at CONFIRMATION and its result is written onto the
 * booking. It is never called to re-derive an existing booking's total on read.
 *
 * That distinction is the whole safety story of this build. Computing on read
 * would be less code and would look identical in a test — and it would silently
 * change the value of every booking already confirmed the moment a venue edited
 * its policy, and would become a second money derivation beside
 * summarizeSchedule. A booking's agreed value does not move because we shipped
 * a feature.
 */

/** Nightly rate falls back through three levels, each narrower than the last. */
const RATE_SOURCE = {
  BOOKING: "booking",   // this deal's own number, typed by the owner
  POLICY: "policy",     // the venue's extra-room rate
  TYPE: "type",         // the room type's public nightly rate
  NONE: "none",         // nothing to charge with
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * The venue's policy in a uniform shape, whatever it holds.
 *
 * An unconfigured venue resolves to ALL rooms included and nothing chargeable —
 * which is precisely today's behaviour, and is why shipping this cannot move an
 * existing total. `configured` keeps "never answered" distinguishable from
 * "answered all-included" so a screen never shows a policy nobody wrote.
 */
function resolvePolicy(venue) {
  const p = (venue && venue.roomsPolicy) || {};
  const configured = p.configured === true;
  return {
    configured,
    sellsNightly: p.sellsNightly === true,
    // Unconfigured means inert. Not a guess about this venue — a refusal to
    // charge for something the owner has not said is chargeable.
    includedWithVenue: configured && p.includedWithVenue ? p.includedWithVenue : "all",
    includedCount: num(p.includedCount, 0),
    extraRoomRate: num(p.extraRoomRate, 0),
  };
}

/** How many rooms this policy includes, given how many the venue has. */
function includedRooms(policy, totalRoomsAtVenue) {
  if (policy.includedWithVenue === "none") return 0;
  if (policy.includedWithVenue === "count") {
    // Never more than the venue has: "8 included" at a 5-room venue means 5,
    // and charging for -3 rooms is not a number anyone should see.
    return Math.min(Math.max(0, Math.round(policy.includedCount)), Math.max(0, totalRoomsAtVenue));
  }
  return Math.max(0, totalRoomsAtVenue); // "all"
}

/**
 * What the rooms cost on ONE booking, with its working shown.
 *
 * @param {object} args
 * @param {object} args.policy        resolvePolicy(venue)
 * @param {number} args.roomsNeeded   how many the booking needs
 * @param {number} args.nights        nights in the stay window
 * @param {number} args.totalRoomsAtVenue   for the "all" case
 * @param {number} [args.typeRate]    the fallback nightly rate off the room type
 * @param {object} [args.override]    this booking's own answer
 * @param {number} [args.override.includedRooms]
 * @param {number} [args.override.ratePerNight]
 */
function quoteRooms({
  policy,
  roomsNeeded = 0,
  nights = 0,
  totalRoomsAtVenue = 0,
  typeRate = 0,
  override = null,
} = {}) {
  const needed = Math.max(0, Math.round(num(roomsNeeded)));
  const nightCount = Math.max(0, Math.round(num(nights)));

  // ── WHICH RATE, AND WHERE IT CAME FROM ──────────────────────────────────
  // Reported rather than merely applied: an owner seeing "₹4,000" with no
  // source cannot tell a policy rate from a type rate from a typo.
  let rate = 0;
  let rateSource = RATE_SOURCE.NONE;
  if (override && Number.isFinite(Number(override.ratePerNight))) {
    rate = Math.max(0, num(override.ratePerNight));
    rateSource = RATE_SOURCE.BOOKING;
  } else if (policy.extraRoomRate > 0) {
    rate = policy.extraRoomRate;
    rateSource = RATE_SOURCE.POLICY;
  } else if (num(typeRate) > 0) {
    rate = num(typeRate);
    rateSource = RATE_SOURCE.TYPE;
  }

  const policyIncluded = includedRooms(policy, totalRoomsAtVenue);
  const overrodeIncluded = override && Number.isFinite(Number(override.includedRooms));
  const included = overrodeIncluded
    ? Math.min(Math.max(0, Math.round(num(override.includedRooms))), needed)
    : Math.min(policyIncluded, needed);

  const chargeable = Math.max(0, needed - included);
  const amount = Math.round(chargeable * rate * nightCount);

  return {
    roomsNeeded: needed,
    nights: nightCount,
    included,
    chargeable,
    ratePerNight: rate,
    rateSource,
    includedSource: overrodeIncluded ? "booking" : policy.configured ? "policy" : "default",
    amount,
    /**
     * The working, as one sentence, built HERE so the wizard, the confirmation
     * PDF, the invoice and the statement all print the same words. An owner
     * should never wonder why the total moved.
     */
    sentence: describeQuote({ needed, included, chargeable, rate, nightCount, amount }),
  };
}

const money = (n) => `Rs. ${Math.round(num(n)).toLocaleString("en-IN")}`;

function describeQuote({ needed, included, chargeable, rate, nightCount, amount }) {
  if (needed === 0) return "No rooms on this booking.";
  if (chargeable === 0) {
    return included >= needed
      ? `${needed} room${needed === 1 ? "" : "s"} — all included with the venue.`
      : `${needed} room${needed === 1 ? "" : "s"}, nothing chargeable.`;
  }
  if (rate === 0) {
    // Said plainly rather than silently charging zero: "12 extra rooms at no
    // rate" is a setup gap the owner can fix, and a 0 that looks deliberate is
    // how a venue gives away twelve rooms.
    return `${needed} rooms · ${included} included · ${chargeable} extra — no rate set, so nothing is charged.`;
  }
  const nightsPart = nightCount === 1 ? "1 night" : `${nightCount} nights`;
  return `${needed} rooms · ${included} included · ${chargeable} × ${money(rate)} × ${nightsPart} = ${money(amount)}`;
}

/** Whole nights between two instants; a same-day stay is one night, not zero. */
function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const a = new Date(checkIn), b = new Date(checkOut);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const days = Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
    - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86400000);
  return Math.max(0, days);
}

module.exports = { resolvePolicy, includedRooms, quoteRooms, nightsBetween, describeQuote, RATE_SOURCE };

/* INVARIANT 1 of 4 — HEADCOUNT (§ 06.3).
 *
 *     headcount = Σ guest.party where rsvp ≠ "no"
 *
 * Computed server-side, consumed by Budget catering, the Home stat, the website
 * RSVP tally and the Payments estimate. NEVER recomputed client-side: four
 * screens deriving their own sum is four numbers that disagree the first time
 * one of them filters a row the others do not.
 *
 * PURE. Takes plain guest objects — lean() documents, seeded fixtures, or the
 * array a test builds by hand — and returns numbers. No mongoose, no clock.
 */

/** A guest counts toward the headcount unless they have said no. */
const counts = (guest) => guest && guest.rsvp !== "no";

/**
 * Party size, defensively.
 *
 * An invitation covers at least the person invited, so a missing or unparseable
 * party is 1 — the value the client's Add-guest form starts at. A stored 0 is
 * respected (a couple can zero a row out deliberately); a negative is not, and
 * clamps to 0 rather than subtracting from the room.
 */
const partyOf = (guest) => {
  const raw = guest && guest.party;
  // Number("") is 0, and an empty form field is "they did not say" — not "no
  // one is coming". Blank goes to the same place as missing.
  if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  return Math.floor(n);
};

/**
 * The whole guest tally for one wedding.
 *
 * @param  {object[]} guests plain guest documents (already scoped to one wedding)
 * @return {{invited:number, yes:number, no:number, pending:number, headcount:number}}
 *
 * `invited` counts INVITATIONS (rows), not people — it is the "218 guests" on
 * the Guests header, next to which "0 replied" is a count of rows too. The
 * headcount is the people number, and it is the only one catering may use.
 */
const tally = (guests) => {
  const rows = Array.isArray(guests) ? guests : [];
  let yes = 0;
  let no = 0;
  let pending = 0;
  let headcount = 0;
  rows.forEach((guest) => {
    if (!guest) return;
    if (guest.rsvp === "yes") yes += 1;
    else if (guest.rsvp === "no") no += 1;
    else pending += 1;
    if (counts(guest)) headcount += partyOf(guest);
  });
  return { invited: rows.length, yes, no, pending, headcount };
};

/** Just the number, for the callers that only want the one. */
const headcount = (guests) => tally(guests).headcount;

/**
 * The same tally, narrowed to one function ("how many are coming to the
 * sangeet"). The Events rule of § 06.3: a day is defined once on the Event and
 * consumed here, so the per-day expected guests on the planner and the guest
 * list's event chips are the same population.
 */
const tallyForEvent = (guests, eventKey) =>
  tally((Array.isArray(guests) ? guests : []).filter(
    (guest) => guest && Array.isArray(guest.events) && guest.events.indexOf(eventKey) !== -1
  ));

module.exports = { tally, headcount, tallyForEvent, partyOf, counts };

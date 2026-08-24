/**
 * utils/venueEventWindow.js — ONE event window, one source, one writer.
 *
 * ── THE RULING THIS IMPLEMENTS ──────────────────────────────────────────────
 * A lead's dates and its booking's dates are THE SAME THING. Not a window on
 * one side and function days on the other: one window, and changing it in
 * either surface changes it everywhere. There is no separate setup/access
 * concept — if a day is inside the window, the venue is sold on that day.
 *
 * Before this module, confirming a booking discarded the lead's window
 * entirely (VenueBooking had no checkIn/checkOut), so a lead reading
 * "29 Sept 4 PM → 1 Oct 4 PM" became a booking reading "30 Sept – 1 Oct" and
 * nothing downstream could recover the missing day.
 *
 * ── WHICH COPY IS CANONICAL ─────────────────────────────────────────────────
 * The BOOKING, once one exists. A booking is the contract: it owns calendar
 * inventory, it is what the couple signed, and it is the thing an invoice and a
 * confirmation PDF are generated from. Before a booking exists the lead is the
 * only holder and is therefore canonical by default.
 *
 * But "canonical" here decides only who WINS A DISAGREEMENT, and the answer is
 * that a disagreement must never exist. Both rows are written inside
 * applyWindowChange(), in one call, and no other code path writes either one
 * once a booking exists. The enquiry's pre-validate still derives eventDate
 * from checkIn, so the platform's single-day readers stay correct too.
 *
 * ── WHY EVERY DAY IN THE WINDOW IS BLOCKED ──────────────────────────────────
 * Blocking used to follow function days, so a window of 29 Sept → 1 Oct with
 * functions only on the 30th and 1st left the 29th SELLABLE while the couple
 * had the venue. That is the same class of bug the ruling exists to remove: a
 * window nobody enforces is decorative. So the desired block set is every
 * venue-day in [checkIn, checkOut] × every space the booking occupies.
 *
 * ── HOW A MOVE IS MADE SAFE WITHOUT TRANSACTIONS ────────────────────────────
 * Mongo here is standalone, so there are no multi-document transactions. The
 * ordering is therefore load-bearing:
 *
 *        CLAIM THE NEW ROWS FIRST, RELEASE THE OLD ROWS ONLY AFTER.
 *
 * Every new row is inserted before a single old row is deleted. If any insert
 * collides with another booking or hold, the rows this call inserted are
 * removed (they carry a private batchRef) and the change is refused with the
 * colliding date named — and because nothing had been released yet, the
 * booking still holds exactly the dates it held before the attempt.
 *
 * The failure mode this ordering chooses is deliberate. A crash between claim
 * and release leaves the booking holding its OLD dates as well as its new ones
 * — over-blocked, visible, and fixable by re-running the same change. The
 * opposite order would leave a window released and unclaimed, which is a date
 * sold twice. Over-blocking is an inconvenience; under-blocking is a couple
 * arriving to find another wedding in their venue.
 *
 * Dates present in BOTH the old and the new window are never touched: they are
 * in neither the add set nor the remove set, so their rows keep their identity
 * and are never momentarily free for someone else to take.
 */
const mongoose = require("mongoose");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueHold = require("../models/VenueHold");
const { venueDateKey, addVenueDays } = require("./venueTime");
const { rederiveRoomNights } = require("./venueRoomNights");

/** Every venue-calendar day the window covers, inclusive of both ends. */
function windowDays(checkIn, checkOut) {
  if (!checkIn || !checkOut) return [];
  const days = [];
  const seen = new Set();
  // Walk on the VENUE's calendar so the same window yields the same days on a
  // UTC prod box and an IST laptop.
  for (let d = new Date(checkIn); venueDateKey(d) <= venueDateKey(checkOut); d = addVenueDays(d, 1)) {
    const key = venueDateKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    // Rows are keyed at UTC midnight of the venue day, matching every existing
    // writer of VenueSpaceDate.
    days.push(new Date(`${key}T00:00:00.000Z`));
    if (days.length > 40) break; // window is capped at 7 days upstream; belt and braces
  }
  return days;
}

/**
 * The spaces a booking occupies, read from the calendar rows it already holds.
 *
 * days[].spaces carries NAMES for display, so it cannot be used here. The
 * VenueSpaceDate rows keyed by bookingRef carry real space ids and are the
 * authoritative record of what this booking took.
 */
async function bookingSpaceIds(bookingId) {
  const rows = await VenueSpaceDate.find({ bookingRef: bookingId }).select("space").lean();
  const ids = new Map();
  for (const r of rows) if (r.space) ids.set(String(r.space), r.space);
  return [...ids.values()];
}

const pairKey = (space, day) => `${space}|${day instanceof Date ? venueDateKey(day) : venueDateKey(new Date(day))}`;

/**
 * What the calendar SHOULD hold for this booking under a given window.
 * @returns Map<pairKey, {space, date}>
 */
function desiredPairs(checkIn, checkOut, spaceIds) {
  const out = new Map();
  for (const day of windowDays(checkIn, checkOut)) {
    for (const space of spaceIds) out.set(pairKey(space, day), { space, date: day });
  }
  return out;
}

/**
 * The holds this window would strand — approved/requested claims on days the
 * new window no longer covers. Never released here; the owner decides.
 */
async function strandedHolds(venueId, enquiryId, checkIn, checkOut) {
  const live = await VenueHold.find({
    venue: venueId,
    linkedEnquiry: enquiryId,
    status: { $in: ["requested", "approved"] },
  })
    .select("_id status dates expiresAt space")
    .lean();
  const covered = new Set(windowDays(checkIn, checkOut).map((d) => venueDateKey(d)));
  return live.filter((h) => (h.dates || []).some((d) => !covered.has(venueDateKey(d))));
}

/**
 * Re-derive a booking's calendar rows for a new window, atomically enough that
 * a failure can never under-block.
 *
 * @returns {{ok:true, added:number, removed:number, kept:number, batchRef}}
 *        | {{ok:false, code:"calendar_conflict", conflicts:[...]}}
 */
async function rederiveCalendar({ venueId, booking, checkIn, checkOut, spaceIds }) {
  const spaces = spaceIds && spaceIds.length ? spaceIds : await bookingSpaceIds(booking._id);
  const desired = desiredPairs(checkIn, checkOut, spaces);

  const current = await VenueSpaceDate.find({ bookingRef: booking._id }).select("_id space date state").lean();
  const currentByKey = new Map(current.map((r) => [pairKey(r.space, r.date), r]));

  const toAdd = [...desired.entries()].filter(([k]) => !currentByKey.has(k)).map(([, v]) => v);
  const toRemove = current.filter((r) => !desired.has(pairKey(r.space, r.date)));
  const kept = current.length - toRemove.length;

  const batchRef = new mongoose.Types.ObjectId();

  // ── CLAIM ────────────────────────────────────────────────────────────────
  // Every new row lands before any old row is released. ordered:true so the
  // first collision stops the batch rather than scattering partial inserts.
  if (toAdd.length) {
    try {
      await VenueSpaceDate.insertMany(
        toAdd.map((p) => ({
          venue: venueId,
          space: p.space,
          date: p.date,
          state: "booked",
          bookingRef: booking._id,
          batchRef,
        })),
        { ordered: true }
      );
    } catch (e) {
      // Undo only what THIS call inserted. batchRef is private to this attempt,
      // so no row belonging to the booking's existing hold on the calendar can
      // be caught by it.
      await VenueSpaceDate.deleteMany({ batchRef });
      if (e.code !== 11000) throw e;
      // Name both sides of every collision. The owner needs to know which date
      // and which commitment, not that "something clashed".
      const conflicts = await describeConflicts(venueId, toAdd, booking._id);
      return { ok: false, code: "calendar_conflict", conflicts };
    }
  }

  // ── RELEASE ──────────────────────────────────────────────────────────────
  // Only now, with every new date safely claimed.
  let removed = 0;
  if (toRemove.length) {
    const del = await VenueSpaceDate.deleteMany({ _id: { $in: toRemove.map((r) => r._id) } });
    removed = del.deletedCount || 0;
  }

  return { ok: true, added: toAdd.length, removed, kept, batchRef };
}

/** Who already holds each date this change wanted, named on both sides. */
async function describeConflicts(venueId, wanted, ownBookingId) {
  const VenueBooking = require("../models/VenueBooking");
  const rows = await VenueSpaceDate.find({
    venue: venueId,
    $or: wanted.map((p) => ({ space: p.space, date: p.date })),
  })
    .select("space date state bookingRef holdRef")
    .lean();

  const out = [];
  for (const r of rows) {
    if (String(r.bookingRef || "") === String(ownBookingId)) continue; // our own, not a clash
    const entry = {
      space: r.space,
      date: r.date,
      day: venueDateKey(r.date),
      state: r.state,
      heldBy: null,
    };
    if (r.bookingRef) {
      const b = await VenueBooking.findById(r.bookingRef).select("coupleName _id").lean();
      entry.heldBy = { kind: "booking", _id: r.bookingRef, coupleName: (b && b.coupleName) || "" };
    } else if (r.holdRef) {
      const h = await VenueHold.findById(r.holdRef).select("_id status linkedEnquiry").lean();
      entry.heldBy = { kind: "hold", _id: r.holdRef, status: (h && h.status) || "" };
    } else {
      entry.heldBy = { kind: "block" };
    }
    out.push(entry);
  }
  return out;
}

/**
 * The functions a proposed window would strand, named well enough for a UI to
 * list them ("Sangeet · 29 Sep") and for an owner to know what they are being
 * asked to move. Day-granularity on the venue calendar, like every other window
 * comparison in this codebase.
 *
 * Lives here rather than in a controller because BOTH surfaces enforce it —
 * editing from the lead and editing from the booking are the same rule, and a
 * second copy is how they would come to disagree.
 */
function outsideWindow(list, checkIn, checkOut) {
  if (!checkIn || !checkOut || !Array.isArray(list)) return [];
  const lo = venueDateKey(checkIn);
  const hi = venueDateKey(checkOut);
  return list
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => {
      if (!f || !f.date) return false;
      const day = venueDateKey(f.date);
      return day < lo || day > hi;
    })
    .map(({ f, i }) => ({
      index: i,
      _id: f._id,
      name: f.name,
      customLabel: f.customLabel || "",
      date: f.date,
      day: venueDateKey(f.date),
    }));
}

/** "Sangeet · 2026-09-29" — for a message rather than a payload. */
function functionSentence(list) {
  return list.map((f) => `${f.customLabel || f.name || "a function"} on ${f.day}`).join("; ");
}

/**
 * THE window writer. Applies a new window to a lead AND its booking, or to
 * neither, re-deriving calendar inventory on the way.
 *
 * Used by the booking-side endpoint; the lead-side PATCH performs the same
 * checks inline (it has to, because it also handles leads with no booking) and
 * shares these primitives rather than re-implementing the rules.
 *
 * @returns {ok:true, calendar} | {ok:false, code, status, body}
 */
async function applyWindowChange({ venue, enquiry, booking, checkIn, checkOut, acknowledgeStaleHolds }) {
  // 1. Functions must still fall inside the window. Named, and blocking.
  const conflictingFunctions = outsideWindow(enquiry.functions, checkIn, checkOut);
  if (conflictingFunctions.length) {
    return {
      ok: false,
      status: 409,
      code: "functions_outside_window",
      body: {
        message: `These dates would leave ${functionSentence(conflictingFunctions)} outside the booking. Move or remove them first.`,
        code: "functions_outside_window",
        conflictingFunctions,
      },
    };
  }

  // 2. Holds on days the new window no longer covers. Never released for the
  //    owner — refused once, applied only on an explicit acknowledgement.
  const stranded = await strandedHolds(venue._id, enquiry._id, checkIn, checkOut);
  if (stranded.length && acknowledgeStaleHolds !== true) {
    return {
      ok: false,
      status: 409,
      code: "stale_holds",
      body: {
        message: "This lead holds dates the new window does not cover — release or re-place the hold",
        code: "stale_holds",
        staleHolds: stranded.map((h) => ({ _id: h._id, status: h.status, dates: h.dates, expiresAt: h.expiresAt, space: h.space })),
        acknowledgeWith: "acknowledgeStaleHolds",
      },
    };
  }

  // 3. Calendar. Claims before it releases, so a refusal changes nothing.
  const calendar = await rederiveCalendar({ venueId: venue._id, booking, checkIn, checkOut });
  if (!calendar.ok) {
    return {
      ok: false,
      status: 409,
      code: "calendar_conflict",
      body: {
        message: `These dates cannot be moved — ${conflictSentence(calendar.conflicts)}. Nothing was changed.`,
        code: "calendar_conflict",
        conflicts: calendar.conflicts,
      },
    };
  }

  // 3b. ROOM NIGHTS, by the same rule as the calendar: claim every new night
  //     before releasing a single old one, so a refusal leaves the reservation
  //     exactly as it was. A window that moves must carry the rooms with it —
  //     otherwise a booking keeps holding nights it no longer needs while the
  //     nights it DOES need sit unreserved, which is the original gap wearing
  //     a different hat.
  const roomsNeeded =
    (enquiry.requirements && enquiry.requirements.roomsNeeded) || booking.roomsRequired || 0;
  let rooms = null;
  if (roomsNeeded > 0) {
    rooms = await rederiveRoomNights({ venue, booking, checkIn, checkOut, needed: roomsNeeded });
    if (!rooms.ok) {
      // The calendar above already committed. Put it back before refusing, so
      // "nothing was changed" is true of the whole edit and not just this half.
      await rederiveCalendar({
        venueId: venue._id,
        booking,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      });
      return {
        ok: false,
        status: 409,
        code: "rooms_conflict",
        body: {
          message:
            "Those dates need rooms that another booking already holds. Nothing was changed.",
          code: "rooms_conflict",
        },
      };
    }
  }

  // 4. Both copies, back to back, only once everything above has passed.
  //    The enquiry's pre-validate derives eventDate from checkIn, so the
  //    platform's single-day readers follow automatically.
  enquiry.checkIn = checkIn;
  enquiry.checkOut = checkOut;
  enquiry.datesFinalised = true;
  await enquiry.save();

  booking.checkIn = checkIn;
  booking.checkOut = checkOut;
  await booking.save();

  return { ok: true, calendar, rooms };
}

/** "29 Sep 2026 · Lawn" — one line per clash, for a message an owner can act on. */
function conflictSentence(conflicts) {
  return conflicts
    .map((c) => {
      const who =
        c.heldBy && c.heldBy.kind === "booking"
          ? c.heldBy.coupleName
            ? `${c.heldBy.coupleName}'s booking`
            : "another booking"
          : c.heldBy && c.heldBy.kind === "hold"
            ? "a hold"
            : "a calendar block";
      return `${c.day} is already taken by ${who}`;
    })
    .join("; ");
}

module.exports = {
  windowDays,
  outsideWindow,
  functionSentence,
  applyWindowChange,
  bookingSpaceIds,
  desiredPairs,
  strandedHolds,
  rederiveCalendar,
  describeConflicts,
  conflictSentence,
  pairKey,
};

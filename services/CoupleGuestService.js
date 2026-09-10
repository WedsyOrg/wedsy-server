/* THE GUEST LIST (§ 05.2, § 06.2) — the couple's single source of truth for
 * who is coming, and the only place a guest number lives.
 *
 * THE TWO THINGS THIS SERVICE REFUSES TO DO ITSELF
 *
 *   1. COUNT. `headcount = Σ party where rsvp ≠ "no"` is
 *      CoupleHeadcountService's (§ 06.3, invariant 1). Budget catering, the
 *      Home stat, the website RSVP tally and the Payments estimate all read
 *      that one function; a second sum here is how the four start disagreeing,
 *      and the one that disagrees is the number somebody caters to.
 *
 *   2. MATCH A PHONE. Guests arrive from three places — typed into the Add
 *      form, imported, and posted by a stranger through the public RSVP form —
 *      and they must not duplicate. CoupleRsvpService.matchGuest is the one
 *      match, built on utils/phone.js, and it already handles the stored row
 *      that predates `phoneNormalised`. A duplicate row is an extra party on
 *      the headcount, in the catering estimate and on the payment that feeds
 *      it, so this service asks that function rather than writing a second.
 */

const Guest = require("../models/Guest");
const CoupleWeddingService = require("./CoupleWeddingService");
const headcountService = require("./CoupleHeadcountService");
const rsvpService = require("./CoupleRsvpService");
const activityService = require("./CoupleActivityService");
const rules = require("./CouplePeopleRules");

const fail = (status, code, message, extra) =>
  Object.assign(new Error(message), { status, code, extra: extra || null });

/**
 * The function keys THIS wedding actually has (§ 06.3 "Events": defined once
 * on the Event, consumed by the Planner, the Guests tab, the Website and the
 * Budget). A wedding whose days are named something else falls back to the
 * five known keys rather than refusing every invitation.
 */
const eventKeysOf = (event) =>
  ((event && event.eventDays) || [])
    .map((day) => CoupleWeddingService.dayKey(day && day.name))
    .filter(Boolean);

/** Fire-and-safe. A feed row that could not be written must not fail a write. */
const note = (couple, { action, guest, summary }) => {
  const actor = rules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "guest",
    objectId: guest && guest._id,
    summary,
    meta: { memberId: actor.memberId ? String(actor.memberId) : null },
  });
};

const fullName = (guest) => [guest.first, guest.last].filter(Boolean).join(" ");

/** GET /wedding/:id/guests ?side&rsvp&event&q */
const list = async (couple, query) => {
  const rows = await Guest.find(rules.guestQuery(couple.weddingId, query))
    .sort({ createdAt: 1 })
    .lean();
  return rows.map(rules.shapeGuest);
};

/**
 * GET /wedding/:id/guests/headcount → { invited, yes, no, pending, headcount }.
 *
 * Deliberately UNFILTERED. The header's "218 guests" and the number catering
 * is ordered against are the whole list, not whatever the couple happens to
 * have typed into the search box.
 */
const headcount = async (couple) => {
  const rows = await Guest.find({ weddingId: couple.weddingId }, { party: 1, rsvp: 1, events: 1 }).lean();
  return headcountService.tally(rows);
};

/** The wedding's guests, in the shape the one match function wants. */
const forMatching = (weddingId) =>
  Guest.find({ weddingId }, { phone: 1, phoneNormalised: 1, first: 1, last: 1 }).lean();

/**
 * The duplicate guard. One number, one row, however it arrived.
 *
 * A blank number never collides: plenty of a couple's guests have no phone at
 * all, and treating "no number" as a match would merge two real people.
 */
const assertNotDuplicate = async (weddingId, phone, ignoreId) => {
  const normalised = rsvpService.normalise(phone);
  if (!normalised) return normalised;
  const rows = await forMatching(weddingId);
  const existing = rsvpService.matchGuest(
    rows.filter((row) => !ignoreId || String(row._id) !== String(ignoreId)),
    phone
  );
  if (existing) {
    throw fail(
      409,
      "duplicate_guest",
      `${[existing.first, existing.last].filter(Boolean).join(" ") || "Someone"} is already on your list with that number.`,
      { guestId: String(existing._id) }
    );
  }
  return normalised;
};

/** POST /wedding/:id/guests */
const create = async (couple, body) => {
  const { fields, errors } = rules.guestFields(body, { eventKeys: eventKeysOf(couple.event) });
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  const phoneNormalised = (await assertNotDuplicate(couple.weddingId, fields.phone)) || "";

  const guest = await Guest.create({
    ...fields,
    weddingId: couple.weddingId,
    phoneNormalised,
    source: "couple",
    createdBy: couple.userId,
    createdByMember: couple.role === "member" && couple.member ? couple.member._id : null,
  });

  await note(couple, {
    action: "guest.added",
    guest,
    summary: `added ${fullName(guest) || "a guest"} to the guest list`,
  });

  return rules.shapeGuest(guest.toObject ? guest.toObject() : guest);
};

/**
 * PATCH /guests/:id
 *
 * `guest` is the document the route already loaded to discover its weddingId —
 * the URL does not carry one, so membership was resolved from the row itself
 * and re-checked by the same middlewares/coupleAuth every other route uses.
 */
const update = async (couple, guest, body) => {
  const { fields, errors } = rules.guestFields(body, {
    partial: true,
    eventKeys: eventKeysOf(couple.event),
  });
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  // Read before the write. `guest` is the lean document the route loaded, so
  // it is a separate object from what findOneAndUpdate returns — but reading
  // "what did it used to be" AFTER the update is the kind of line that is
  // correct until somebody passes a live document into it.
  const wasRsvp = guest.rsvp;
  const patch = { ...fields };
  // A phone EDIT re-derives the match key. Leave it stale and the next website
  // reply from that guest creates a second row for the same person.
  if (Object.prototype.hasOwnProperty.call(fields, "phone")) {
    patch.phoneNormalised = (await assertNotDuplicate(couple.weddingId, fields.phone, guest._id)) || "";
  }
  if (Object.prototype.hasOwnProperty.call(fields, "rsvp") && fields.rsvp !== "pending") {
    patch.repliedAt = guest.repliedAt || new Date();
  }

  const saved = await Guest.findOneAndUpdate(
    { _id: guest._id, weddingId: couple.weddingId },
    { $set: patch },
    { new: true }
  ).lean();
  if (!saved) throw fail(404, "not_found", "We could not find that guest.");

  // The reply is the change a human wants to hear about; a party size nudged
  // by one is not, and four of them in the digest crowds out the venue.
  if (patch.rsvp && patch.rsvp !== wasRsvp) {
    await note(couple, {
      action: "guest.rsvp",
      guest: saved,
      summary:
        patch.rsvp === "yes"
          ? `marked ${fullName(saved)} as coming`
          : patch.rsvp === "no"
          ? `marked ${fullName(saved)} as not coming`
          : `reset ${fullName(saved)}'s reply`,
    });
  }

  return rules.shapeGuest(saved);
};

/** DELETE /guests/:id */
const remove = async (couple, guest) => {
  const deleted = await Guest.findOneAndDelete({ _id: guest._id, weddingId: couple.weddingId }).lean();
  if (!deleted) throw fail(404, "not_found", "We could not find that guest.");
  await note(couple, {
    action: "guest.removed",
    guest: deleted,
    summary: `removed ${fullName(deleted) || "a guest"} from the guest list`,
  });
  return { ok: true, id: String(deleted._id) };
};

module.exports = { list, headcount, create, update, remove, eventKeysOf, assertNotDuplicate };

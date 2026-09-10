/* INVARIANT 4 of 4 — WEBSITE RSVP → GUESTS (§ 06.3).
 *
 *   "Website RSVP → Guest record. Match on phone; create if unmatched; always
 *    append an Activity. The Guests tab and the website dashboard render the
 *    *same* numbers."
 *
 * THE MATCH IS THE WHOLE PROBLEM. The couple typed "+91 98450 11223" into their
 * guest list; the guest's phone posts "+919845011223". Same person, two
 * strings, and comparing them raw creates a duplicate row — which then shows up
 * as an extra party on the headcount, in the catering estimate, and on the
 * payment it feeds. So BOTH SIDES are normalised, through utils/phone.js, which
 * is this repo's one phone implementation and stays the one: a second rule here
 * is how a +971 guest ends up matched to a stranger.
 *
 * PURE. Guests in as plain objects, decisions out as plain objects. The caller
 * does the writing. tests/couple-rsvp-match.test.js runs every branch with no
 * database.
 */

const { normalisePhone } = require("../utils/phone");
const { RSVP_STATUS, EVENT_KEY } = require("../utils/coupleEnums");
const headcountService = require("./CoupleHeadcountService");

/** Digits with a country code, or null. The ONE normalisation, both sides. */
const normalise = (raw) => normalisePhone(raw, { context: "couple-rsvp" });

/**
 * Find this wedding's guest by phone.
 *
 * Both sides normalised. A stored row that predates phoneNormalised (or was
 * imported without one) still matches, because its raw `phone` is normalised
 * here too — the denormalised column is an index, not the truth.
 */
const matchGuest = (guests, phone) => {
  const target = normalise(phone);
  if (!target) return null;
  const rows = Array.isArray(guests) ? guests : [];
  return (
    rows.find((guest) => {
      if (!guest) return false;
      const stored = guest.phoneNormalised || normalise(guest.phone);
      return Boolean(stored) && stored === target;
    }) || null
  );
};

/** "Ananya Sharma" → { first: "Ananya", last: "Sharma" }. One word is a first name. */
const splitName = (raw) => {
  const parts = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
};

/**
 * Validate a public submission. Returns the 422 body's `fields` map, empty when
 * the submission is good — the shape wedsy-user's siteApi.rsvp() documents.
 */
const validate = (body) => {
  const fields = {};
  const b = body || {};
  if (!String(b.name || "").trim()) fields.name = "Please tell us your name.";
  if (!normalise(b.phone)) fields.phone = "That does not look like a phone number.";
  if (b.attending !== "yes" && b.attending !== "no") fields.attending = "Please say whether you can come.";
  const party = Number(b.party);
  if (!Number.isFinite(party) || party < 1) fields.party = "How many of you are coming?";
  if (b.events !== undefined && !Array.isArray(b.events)) fields.events = "Which functions?";
  return fields;
};

/** Keep only the function keys this wedding actually has. */
const cleanEvents = (events, allowed) => {
  const list = Array.isArray(events) ? events : [];
  const permitted = Array.isArray(allowed) && allowed.length ? allowed : EVENT_KEY;
  return list.filter((key) => permitted.indexOf(key) !== -1);
};

/**
 * Decide what one public RSVP does.
 *
 * @param {object}   submission  { name, phone, attending, events, party, note }
 * @param {object[]} guests      this wedding's guests (plain)
 * @param {string}   weddingId
 * @param {string[]} [eventKeys] the functions this wedding has
 * @param {Date}     [now]
 *
 * @returns {object} one of
 *   { ok:false, status:422, body:{error:"validation", fields} }
 *   { ok:false, status:409, body:{error:"already_replied", rsvp, party, repliedAt, name} }
 *   { ok:true,  matched:boolean, guestId|null, create|update, activity, response }
 *
 * `response.headcount` is recomputed from the guest list WITH this reply applied
 * — never the client's arithmetic, and never the pre-reply number.
 */
const applyRsvp = ({ submission, guests, weddingId, eventKeys, now = new Date() } = {}) => {
  const fields = validate(submission);
  if (Object.keys(fields).length) {
    return { ok: false, status: 422, body: { error: "validation", fields } };
  }

  const body = submission || {};
  const rows = Array.isArray(guests) ? guests : [];
  const phoneNormalised = normalise(body.phone);
  const rsvp = body.attending === "yes" ? "yes" : "no";
  const party = Math.max(1, Math.floor(Number(body.party)));
  const events = cleanEvents(body.events, eventKeys);
  const existing = matchGuest(rows, body.phone);

  // ONE REPLY PER GUEST. A second submission from a guest who has already
  // answered is the 409 the client renders as "you have already replied" —
  // silently overwriting it would let a stranger with a guessed number edit
  // somebody else's party size.
  if (existing && existing.rsvp && existing.rsvp !== "pending") {
    return {
      ok: false,
      status: 409,
      body: {
        error: "already_replied",
        rsvp: existing.rsvp,
        party: existing.party,
        repliedAt: existing.repliedAt || null,
        name: [existing.first, existing.last].filter(Boolean).join(" "),
      },
    };
  }

  const named = splitName(body.name);
  const note = String(body.note || "").slice(0, 2000);

  let update = null;
  let create = null;
  let applied;

  if (existing) {
    update = {
      _id: existing._id,
      $set: {
        rsvp,
        party,
        repliedAt: now,
        // The guest knows which functions they are coming to better than the
        // couple's guess did — but an empty list is "they did not say", and
        // must not wipe the invitation.
        ...(events.length ? { events } : {}),
        ...(note ? { note } : {}),
      },
    };
    applied = { ...existing, rsvp, party, events: events.length ? events : existing.events };
  } else {
    create = {
      weddingId,
      first: named.first,
      last: named.last,
      // An unmatched reply is a real person the couple had not listed. `side`
      // is required by the schema and nobody knows it yet — "bride" is a
      // placeholder the couple corrects on the Guests tab, and `source:
      // "website"` is how that tab knows to ask.
      side: "bride",
      group: "",
      phone: String(body.phone || "").trim(),
      phoneNormalised,
      party,
      events,
      rsvp,
      note,
      source: "website",
      repliedAt: now,
    };
    applied = create;
  }

  // The headcount AFTER this reply, from the same function every other screen
  // uses. This is the number the website dashboard and the Guests tab share.
  const after = existing
    ? rows.map((guest) => (guest === existing ? applied : guest))
    : rows.concat([applied]);
  const tally = headcountService.tally(after);

  return {
    ok: true,
    matched: Boolean(existing),
    guestId: existing ? existing._id : null,
    update,
    create,
    // § 06.3 — ALWAYS an Activity, matched or not. Built here so no branch can
    // return without one.
    activity: {
      weddingId,
      actorType: "guest",
      actorName: [named.first, named.last].filter(Boolean).join(" ") || "A guest",
      action: "guest.rsvp",
      objectType: "guest",
      summary:
        rsvp === "yes"
          ? `replied yes for ${party} ${party === 1 ? "person" : "people"}`
          : "replied that they cannot come",
      at: now,
    },
    response: {
      ok: true,
      matched: Boolean(existing),
      guestId: existing ? String(existing._id) : null,
      rsvp,
      party,
      headcount: tally.headcount,
    },
    tally,
  };
};

module.exports = { normalise, matchGuest, splitName, validate, cleanEvents, applyRsvp, RSVP_STATUS };

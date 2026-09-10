/* THE PEOPLE RULES — guests, tasks and family sharing, as PURE FUNCTIONS.
 *
 * Same shape as services/CouplePermissions.js and CoupleHeadcountService.js:
 * nothing here touches mongoose, express or the clock, so every branch is
 * unit-testable with no database (tests/couple-guest-filter.test.js,
 * couple-tasks-union.test.js, couple-member-access.test.js,
 * couple-people-permissions.test.js) and the services below are left with
 * nothing to decide except what to read and what to write.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   • The headcount. It is CoupleHeadcountService's, called never copied —
 *     four screens read that number and a second implementation is how they
 *     start disagreeing (§ 06.3, invariant 1).
 *   • Phone normalisation. utils/phone.js is this repo's one implementation
 *     and CoupleRsvpService.normalise/matchGuest is the one MATCH built on it.
 *     Guests arrive from three places — typed, imported, and the public RSVP
 *     form — and a second rule here is a duplicate row, which is an extra
 *     party on the headcount, in the catering estimate and on the payment
 *     that feeds it.
 *   • The access map's meaning. CouplePermissions answers "may they?"; this
 *     file only answers "is this a map we will store at all?".
 */

const {
  RSVP_STATUS, SIDE, EVENT_KEY, ACCESS_LEVEL, SECTION, RELATIONS, DEFAULT_ACCESS,
} = require("../utils/coupleEnums");

/* ── shared ───────────────────────────────────────────────────────────────── */

/** A user-typed search string is not a pattern. Escape before it becomes one. */
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trimmed = (value, max) => {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return max ? text.slice(0, max) : text;
};

/**
 * Who is doing this, for the Activity row (§ 06.3).
 *
 * ActivityLog.actorId is `ref: "Admin"`, so a partner or a shared member goes
 * in meta.actor — CoupleActivityService.buildLog does that mapping and this
 * only supplies the identity. A partner's display name comes off the Event's
 * own partners[] (the CRM's brideName/groomName are the fallback there), a
 * member's off their SharedMember row.
 */
const actorOf = (couple) => {
  if (!couple) return { type: "system", id: null, name: "" };
  if (couple.role === "member" && couple.member) {
    return { type: "couple", id: couple.userId, name: couple.member.name || "", memberId: couple.member._id || null };
  }
  const event = couple.event || {};
  const partners = (event.coupleApp && event.coupleApp.partners) || [];
  const mine = partners.find((p) => p && p.user && String(p.user) === String(couple.userId));
  const name =
    (mine && mine.name) ||
    (couple.user && (couple.user.name || couple.user.fullName)) ||
    event.brideName ||
    "";
  return { type: "couple", id: couple.userId, name, memberId: null };
};

/* ── guests ───────────────────────────────────────────────────────────────── */

/**
 * `?q=` → the clause that mirrors what the Guest list's own box does
 * (components/plan/views/Guests.js): every word must appear somewhere in the
 * name, the group or the number. Two words so "meera iy" finds Meera Iyer,
 * which a single regex over one field cannot.
 *
 * Digits are matched against phoneNormalised as well as the raw `phone`, so a
 * couple searching "9845011223" finds the row they typed as "+91 98450 11223".
 */
const guestSearch = (q) => {
  const raw = trimmed(q, 120);
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!tokens.length) return null;
  const clauses = tokens.map((token) => {
    const rx = new RegExp(escapeRegex(token), "i");
    const or = [{ first: rx }, { last: rx }, { group: rx }, { phone: rx }];
    const digits = token.replace(/[^0-9]/g, "");
    // Two digits match half the list; three is the shortest fragment worth a
    // phone search.
    if (digits.length >= 3) or.push({ phoneNormalised: new RegExp(escapeRegex(digits)) });
    return { $or: or };
  });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

/**
 * GET /wedding/:id/guests ?side&rsvp&event&q → the mongo filter.
 *
 * AN UNRECOGNISED FILTER VALUE IS NOT A FILTER. "all" (what the client sends
 * for "no filter"), blank, and a value outside the enum all narrow nothing.
 * That is the same instinct as the headcount service's unknown `rsvp`: the
 * guest list is the couple's single source of truth, and a filter the server
 * does not understand must never quietly remove people from it. The other
 * direction — narrowing to a value nothing can match — renders as "you have no
 * guests", which is a lie about their own list.
 *
 * `events` is an array on the document, so an equality match on `events` means
 * "contains this key" in mongo. That is exactly the question being asked.
 */
const guestQuery = (weddingId, query = {}) => {
  const filter = { weddingId };
  const q = query || {};

  const side = trimmed(q.side).toLowerCase();
  if (SIDE.indexOf(side) !== -1) filter.side = side;

  const rsvp = trimmed(q.rsvp).toLowerCase();
  if (RSVP_STATUS.indexOf(rsvp) !== -1) filter.rsvp = rsvp;

  const event = trimmed(q.event).toLowerCase();
  if (EVENT_KEY.indexOf(event) !== -1) filter.events = event;

  const search = guestSearch(q.q);
  if (search) Object.assign(filter, search);

  return filter;
};

/** A Guest document → the row § 05.2's data contract describes. */
const shapeGuest = (guest) => ({
  id: String((guest && guest._id) || ""),
  first: (guest && guest.first) || "",
  last: (guest && guest.last) || "",
  side: (guest && guest.side) || "bride",
  group: (guest && guest.group) || "",
  phone: (guest && guest.phone) || "",
  party: Number(guest && guest.party) || 0,
  events: (guest && Array.isArray(guest.events) ? guest.events : []).slice(),
  rsvp: (guest && guest.rsvp) || "pending",
  note: (guest && guest.note) || "",
  // Where the row came from. A "website" row is somebody the couple had not
  // listed, and the Guests tab uses it to ask which side they are.
  source: (guest && guest.source) || "couple",
});

/**
 * Validate and narrow a guest body.
 *
 * @param {object}   body
 * @param {object}   opts
 * @param {boolean}  opts.partial  PATCH — only the keys that were sent
 * @param {string[]} opts.eventKeys the functions THIS wedding actually has
 *                   (§ 06.3 "Events": defined once on the Event, consumed here)
 * @returns {{fields:object, errors:object}}
 */
const guestFields = (body, { partial = false, eventKeys = null } = {}) => {
  const b = body && typeof body === "object" ? body : {};
  const fields = {};
  const errors = {};
  const sent = (key) => Object.prototype.hasOwnProperty.call(b, key);

  if (!partial || sent("first")) {
    const first = trimmed(b.first, 100);
    if (!first) errors.first = "Give them a first name so you know who this is.";
    else fields.first = first;
  }
  if (sent("last")) fields.last = trimmed(b.last, 100);
  if (sent("group")) fields.group = trimmed(b.group, 80);
  if (sent("note")) fields.note = trimmed(b.note, 2000);

  if (!partial || sent("side")) {
    const side = trimmed(b.side).toLowerCase();
    // Whose family they are is not something to guess: it drives the Guests
    // filter and the website's per-side tally.
    if (SIDE.indexOf(side) === -1) errors.side = "Say whether they are the bride's guest or the groom's.";
    else fields.side = side;
  }

  if (!partial || sent("rsvp")) {
    const rsvp = trimmed(b.rsvp).toLowerCase() || (partial ? "" : "pending");
    if (RSVP_STATUS.indexOf(rsvp) === -1) errors.rsvp = "That is not a reply we recognise.";
    else fields.rsvp = rsvp;
  }

  if (!partial || sent("party")) {
    const party = Number(b.party);
    // An invitation covers at least the person invited — the same rule the
    // headcount service applies to a party it cannot read.
    if (b.party === undefined || b.party === null || String(b.party).trim() === "") fields.party = 1;
    else if (!Number.isFinite(party) || party < 0) errors.party = "How many of them are coming?";
    else fields.party = Math.floor(party);
  }

  if (!partial || sent("events")) {
    const list = Array.isArray(b.events) ? b.events : [];
    const allowed = Array.isArray(eventKeys) && eventKeys.length ? eventKeys : EVENT_KEY;
    if (b.events !== undefined && !Array.isArray(b.events)) errors.events = "Which functions are they invited to?";
    else fields.events = list.filter((key) => allowed.indexOf(key) !== -1);
  }

  // The raw string is kept as the couple typed it; the normalised form is
  // derived by the service through utils/phone, never here.
  if (!partial || sent("phone")) fields.phone = trimmed(b.phone, 30);

  return { fields, errors };
};

/* ── tasks ────────────────────────────────────────────────────────────────── */

/**
 * WHERE A COUPLE-APP WRITE MAY LAND. One value, one place.
 *
 * GET /wedding/:id/tasks is the union of CoupleTask and the CRM's
 * WeddingMilestone, and the union is READ-ONLY on the milestone half: those
 * rows are the team's plan for the couple, rendered inside the CRM lead page,
 * and the couple app must leave them exactly as it found them.
 */
const WRITABLE_TASK_SOURCE = "couple";

/** Is this shaped row one the couple app may write to? Unknown ⇒ NO. */
const isWritableTask = (row) =>
  Boolean(row) && row.source === WRITABLE_TASK_SOURCE && row.readOnly !== true;

/**
 * Undated tasks sink below dated ones — the same order the Tasks screen
 * applies, so the first page the couple sees does not reshuffle on load.
 */
const taskOrder = (a, b) => {
  const at = a && a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b && b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
  const av = Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  const bv = Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER;
  if (av !== bv) return av - bv;
  return String((a && a.title) || "").localeCompare(String((b && b.title) || ""));
};

/** Validate and narrow a task body. */
const taskFields = (body, { partial = false } = {}) => {
  const b = body && typeof body === "object" ? body : {};
  const fields = {};
  const errors = {};
  const sent = (key) => Object.prototype.hasOwnProperty.call(b, key);

  if (!partial || sent("title")) {
    const title = trimmed(b.title, 300);
    if (!title) errors.title = "Give the task a name so you know what it is.";
    else fields.title = title;
  }

  if (!partial || sent("dueDate")) {
    const raw = b.dueDate;
    if (raw === undefined || raw === null || String(raw).trim() === "") fields.dueDate = null;
    else {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) errors.dueDate = "That does not look like a date.";
      else fields.dueDate = date;
    }
  }

  if (sent("done")) fields.done = Boolean(b.done);
  // § 05.3 "remind" — A TRIGGER FLAG ONLY. Storing it sends nothing; see the
  // marked comment in services/CoupleTaskService.js.
  if (sent("remind")) fields.remind = Boolean(b.remind);

  return { fields, errors };
};

/**
 * The refusal for a write aimed at a WeddingMilestone id.
 *
 * A 403 with the foundation's body shape, not a 404: the row is real and this
 * person can see it on their own Tasks screen. What they cannot do is change
 * it, and the message says whose it is rather than pretending it is missing.
 */
const milestoneDenial = () => ({
  error: "forbidden",
  section: "tasks",
  required: "edit",
  held: "view",
  message: "That one is on your planner's timeline — ask them to change it. Tasks you add yourself you can edit here.",
});

/* ── members (family sharing, § 05.5 / § 06.4) ────────────────────────────── */

/**
 * ONE OF THE SEVENTEEN, OR NOTHING.
 *
 * models/SharedMember stores `relation` as free text so a future screen can
 * offer more; THIS ENDPOINT does not, because the screen that renders it is a
 * chip picker over exactly these seventeen (You.js compares `form.relation === r`)
 * and a value outside the list would render as no chip selected at all — an
 * invitation the couple cannot then edit. Matched case-insensitively and
 * stored in the list's own spelling, so "bride's mother" and "Bride's Mother"
 * are the same relation and not two.
 */
const relationOf = (raw) => {
  const value = trimmed(raw, 80);
  if (!value) return null;
  return RELATIONS.find((preset) => preset.toLowerCase() === value.toLowerCase()) || null;
};

/**
 * SIX KEYS OUT, ALWAYS, EACH ONE OF THREE VALUES.
 *
 * This is the structural half of § 06.4. A caller who posts
 * `{ guests: "edit", payouts: "edit" }` gets a map with six keys and no
 * seventh — the extra key is not rejected with an error the caller could work
 * around, it simply has nowhere to go. An unknown LEVEL is "none" for the same
 * reason: fail closed, exactly as CouplePermissions.levelFor does when it
 * reads the stored map back.
 *
 * A key that was not sent is "none" rather than "whatever it was", which means
 * a partial map can only ever REDUCE what a member holds. That is the safe
 * direction, and the screen always sends all six.
 */
const accessMapFrom = (raw, fallback) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_ACCESS;
    const map = {};
    SECTION.forEach((section) => {
      map[section] = ACCESS_LEVEL.indexOf(base[section]) !== -1 ? base[section] : "none";
    });
    return map;
  }
  const map = {};
  SECTION.forEach((section) => {
    const level = raw[section];
    map[section] = ACCESS_LEVEL.indexOf(level) !== -1 ? level : "none";
  });
  return map;
};

/** Validate and narrow a member body. */
const memberFields = (body, { partial = false } = {}) => {
  const b = body && typeof body === "object" ? body : {};
  const fields = {};
  const errors = {};
  const sent = (key) => Object.prototype.hasOwnProperty.call(b, key);

  if (!partial || sent("name")) {
    const name = trimmed(b.name, 120);
    if (!name) errors.name = "Give them a name so you can tell who is who.";
    else fields.name = name;
  }

  if (!partial || sent("relation")) {
    const relation = relationOf(b.relation);
    if (!relation) errors.relation = "Choose how they are related — it is how the rest of your family will recognise them.";
    else fields.relation = relation;
  }

  if (!partial || sent("access")) {
    fields.access = accessMapFrom(b.access, DEFAULT_ACCESS);
  }

  // ⛏ CONTRACT GAP, and an OPTIONAL field here because of it. The invite form
  // (§ 05.5) asks for a name and a relation and NOTHING ELSE — so a member
  // created from the finished screen has no number to send the invite to and
  // no way to bind to a User account, and `acceptedAt` can never become
  // non-null. Accepted here when a caller does send one; written up in
  // docs/couple-app-api.md § People. There is deliberately no `email`:
  // models/SharedMember has no such field, and a value mongoose would silently
  // drop is worse than one the API never promised.
  if (sent("phone")) fields.phone = trimmed(b.phone, 30);

  return { fields, errors };
};

/** A SharedMember document → the row § 05.5 renders. Never the invite token. */
const shapeMember = (member) => ({
  id: String((member && member._id) || ""),
  name: (member && member.name) || "",
  relation: (member && member.relation) || "",
  access: accessMapFrom(member && member.access, DEFAULT_ACCESS),
  phone: (member && member.phone) || "",
  invitedAt: (member && member.invitedAt) || null,
  // Null until they open the invite. "Not shared with them yet" until then.
  acceptedAt: (member && member.acceptedAt) || null,
});

/**
 * THE MEMBERS-MANAGEMENT REFUSAL — the partner-only gate's body.
 *
 * Same structural argument as payouts. "members" is deliberately NOT one of
 * the six grantable sections in utils/coupleEnums.SECTION, so
 * SharedMember.access has no key for it and no configuration of that document
 * can grant it. A shared family member with all six sections at "edit" reads
 * this: they can work on the wedding, they cannot change who else gets in.
 *
 * `error: "forbidden"` is the foundation's own key — wedsy-user's read() keys
 * 401/403 as "denied, never substitute the seed" on exactly that.
 */
const partnerDenial = () => ({
  error: "forbidden",
  section: "members",
  required: "partner",
  held: "none",
  message: "Only the couple can add or change who has access to this wedding.",
});

module.exports = {
  escapeRegex,
  actorOf,
  guestSearch,
  guestQuery,
  shapeGuest,
  guestFields,
  WRITABLE_TASK_SOURCE,
  isWritableTask,
  taskOrder,
  taskFields,
  milestoneDenial,
  relationOf,
  accessMapFrom,
  memberFields,
  shapeMember,
  partnerDenial,
};

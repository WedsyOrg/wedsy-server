/* THE BUDGET ESTIMATOR (§ 3.2.3, § 06.2 `POST /wedding/:id/budget/estimate`).
 *
 * PURE. Bands in, a number out. No mongoose, no clock, no express.
 *
 * ── WHY THE SERVER COMPUTES THIS AT ALL ────────────────────────────────────
 * The client already has an estimator (`wedsy-user/lib/plan/seed/budget.js`)
 * and it draws the live number as the couple taps. That one is a RENDERER: it
 * exists so the figure moves under their finger. The stored estimate — the one
 * the Wedsy team opens, the one Home's budget card reads — cannot be whatever
 * a browser posted, because two of its inputs are not the browser's to state:
 *
 *   HEADCOUNT is § 06.3 invariant 1 — "computed server-side, consumed by
 *   Budget catering… never recomputed client-side". `buildEstimate` here takes
 *   it as an argument and the caller gets it from CoupleHeadcountService over
 *   the wedding's real Guest rows. A `headcount` in the request body reaches
 *   no variable in this file.
 *
 *   DAYS is § 06.3 "Events: defined once". It is the number of DISTINCT DATES
 *   the chosen functions fall on, read off Event.eventDays — a wedding and a
 *   reception on one date is one day of venue rental, and the couple has
 *   already told us their dates. A `days` in the request body reaches no
 *   variable either.
 *
 * ── THE BANDS ARE THE CLIENT'S, DELIBERATELY VERBATIM ──────────────────────
 * Every rate below is the same rupee figure the choice card shows the couple
 * on the screen that uses it. § 3.2.3's whole claim is that the number is
 * honest: no hidden multiplier, and what they read on a card is what goes into
 * the arithmetic. A rate that differs from the client's by a rupee is a screen
 * and a server telling one couple two things, so `tests/couple-budget-
 * estimate.test.js` asserts the two tables agree figure for figure.
 */

/* ------------------------------------------------------------------ bands */

const VENUE_TYPES = [
  { id: "lawn", label: "Lawn or open-air", rate: 65000 },
  { id: "banquet", label: "Banquet hall", rate: 120000 },
  { id: "convention", label: "Convention centre", rate: 165000 },
  { id: "resort", label: "Resort or palace", rate: 240000 },
];

const DECOR_TIERS = [
  { id: "essential", label: "Essential", rate: 95000 },
  { id: "signature", label: "Signature", rate: 156000 },
  { id: "royal", label: "Royal", rate: 280000 },
];

const CATERING_BANDS = [
  { id: "silver", label: "Silver", rate: 900 },
  { id: "gold", label: "Gold", rate: 1400 },
  { id: "platinum", label: "Platinum", rate: 2200 },
];

const SERVICES = [
  { id: "photo", label: "Photo and video", rate: 165000 },
  { id: "makeup", label: "Makeup and beauty", rate: 95000 },
  { id: "entertainment", label: "Entertainment", rate: 135000 },
  { id: "invites", label: "Invites and gifting", rate: 130, perGuest: true },
  { id: "mehndi", label: "Mehndi artists", rate: 60000 },
  { id: "hospitality", label: "Guest hospitality", rate: 260, perGuest: true },
];

const ROOM_BANDS = [
  { id: "none", label: "None", rooms: 0 },
  { id: "few", label: "About 10", rooms: 10 },
  { id: "some", label: "About 20", rooms: 20 },
  { id: "many", label: "About 35", rooms: 35 },
  { id: "lots", label: "About 50", rooms: 50 },
];

const ROOM_NIGHT_RATE = 3800;

const DEFAULT_ANSWERS = {
  venueType: "banquet",
  decorType: "signature",
  cateringType: "gold",
  roomBand: "many",
  services: { photo: true, makeup: true, invites: true },
};

const CATEGORIES = [
  { id: "venue", label: "Venue rental" },
  { id: "catering", label: "Catering" },
  { id: "decor", label: "Décor and styling" },
  { id: "stay", label: "Stay for family" },
  { id: "services", label: "Services" },
];

/* ---------------------------------------------------------------- helpers */

const byId = (list, id, fallback) =>
  list.find((row) => row.id === id) || list.find((row) => row.id === fallback) || list[0];

const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Which functions this estimate covers.
 *
 * `chosen` is what the couple ticked — the client posts an array of function
 * KEYS (`{ events: ["haldi", "wedding"] }`); the wizard's own state is a map
 * of keys switched OFF. Both shapes are accepted and BOTH are intersected with
 * the wedding's real days, because § 06.3 says the functions are defined once
 * on the Event: a key this wedding does not have cannot buy a day of catering.
 *
 * An empty or unrecognised selection means EVERY function, not none — a
 * request that named nothing is a couple who has not narrowed it down, and an
 * estimate of ₹0 is not an answer they would believe.
 */
const chosenDays = (days, chosen) => {
  const rows = Array.isArray(days) ? days : [];
  if (!chosen) return rows;
  if (Array.isArray(chosen)) {
    const wanted = new Set(chosen.map((key) => String(key)));
    const narrowed = rows.filter((day) => wanted.has(String(day.key)) || wanted.has(String(day.id)));
    return narrowed.length ? narrowed : rows;
  }
  if (typeof chosen === "object") {
    const narrowed = rows.filter((day) => chosen[day.key] !== false);
    return narrowed.length ? narrowed : rows;
  }
  return rows;
};

/** Which services are on. Accepts the map the wizard holds or the list it posts. */
const chosenServices = (value) => {
  if (Array.isArray(value)) {
    const wanted = new Set(value.map((id) => String(id)));
    return SERVICES.filter((service) => wanted.has(service.id));
  }
  const map = value && typeof value === "object" ? value : DEFAULT_ANSWERS.services;
  return SERVICES.filter((service) => map[service.id]);
};

/**
 * How many rooms. A band id, or the raw count the client posts
 * (`rooms: estimate.roomBand.rooms`). A count is taken at its word rather than
 * snapped to the nearest band — the couple's own number beats our five buckets.
 */
const roomsFor = (answers) => {
  if (answers && answers.rooms !== undefined && answers.rooms !== null && answers.rooms !== "") {
    const n = Number(answers.rooms);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return byId(ROOM_BANDS, answers && answers.roomBand, DEFAULT_ANSWERS.roomBand).rooms;
};

/* -------------------------------------------------------------- the maths */

/**
 * Build the estimate.
 *
 * @param {object}   answers   the wizard's answers, in either shape
 * @param {number}   headcount SERVER-computed (§ 06.3 invariant 1)
 * @param {object[]} days      the wedding's functions — { id, key, name, date }
 * @returns a shape the screen renders directly, every line carrying the
 *          arithmetic that produced it.
 */
const buildEstimate = ({ answers = {}, headcount = 0, days = [] } = {}) => {
  const a = answers && typeof answers === "object" ? answers : {};
  const chosen = chosenDays(days, a.events !== undefined ? a.events : a.functions);

  // DAYS = distinct dates. Not the number of functions: § 06.3 "Events".
  const dayCount = new Set(chosen.map((day) => String(day.date || day.id))).size;

  const venueType = byId(VENUE_TYPES, a.venue || a.venueType, DEFAULT_ANSWERS.venueType);
  const decorTier = byId(DECOR_TIERS, a.decor || a.decorType, DEFAULT_ANSWERS.decorType);
  const cateringBand = byId(CATERING_BANDS, a.catering || a.cateringType, DEFAULT_ANSWERS.cateringType);
  const rooms = roomsFor(a);
  const seats = Math.max(0, Math.floor(Number(headcount) || 0));

  const venue = venueType.rate * dayCount;

  // ONE CATERING LINE PER FUNCTION, each of them the SERVER's headcount times
  // the per-plate band. The couple is never asked how many are coming; they
  // have already said, on the Guest list.
  const cateringLines = chosen.map((day) => ({
    id: day.id || day.key,
    label: day.name || day.key,
    seats,
    rate: cateringBand.rate,
    amount: cateringBand.rate * seats,
  }));
  const catering = cateringLines.reduce((sum, line) => sum + line.amount, 0);

  const decorLines = chosen.map((day) => ({
    id: day.id || day.key,
    label: day.name || day.key,
    amount: decorTier.rate,
  }));
  const decor = decorTier.rate * chosen.length;

  const stay = rooms * ROOM_NIGHT_RATE * dayCount;

  const serviceLines = chosenServices(a.services).map((service) => ({
    id: service.id,
    label: service.label,
    perGuest: Boolean(service.perGuest),
    rate: service.rate,
    seats,
    amount: service.perGuest ? service.rate * seats : service.rate,
  }));
  const services = serviceLines.reduce((sum, line) => sum + line.amount, 0);

  const amounts = { venue, catering, decor, stay, services };
  const categories = CATEGORIES.map((category) => ({
    ...category,
    amount: amounts[category.id] || 0,
  }));

  return {
    total: categories.reduce((sum, category) => sum + category.amount, 0),
    categories,
    days: dayCount,
    functions: chosen.map((day) => ({ id: day.id, key: day.key, name: day.name, date: day.date })),
    seats,
    venueType,
    decorTier,
    cateringBand,
    rooms,
    cateringLines,
    decorLines,
    serviceLines,
  };
};

/**
 * What gets STORED in Event.coupleApp.budget.estimateAnswers.
 *
 * A whitelist, exactly as the website milestone's settings patch is: the keys
 * this file can actually read, and nothing else. A body carrying `estimate:
 * 1`, `headcount: 9999` or `days: 1` posts fields that reach no variable,
 * because the two figures that matter are the server's and there is no
 * parameter here for either.
 */
const estimateAnswers = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const out = {};
  if (b.events !== undefined || b.functions !== undefined) {
    const value = b.events !== undefined ? b.events : b.functions;
    if (Array.isArray(value)) out.events = value.map((key) => String(key)).slice(0, 20);
    else if (value && typeof value === "object") out.functions = value;
  }
  const pick = (key, list, alt) => {
    const raw = b[key] !== undefined ? b[key] : b[alt];
    if (raw === undefined || raw === null) return;
    const match = list.find((row) => row.id === String(raw));
    if (match) out[key] = match.id;
  };
  pick("venue", VENUE_TYPES, "venueType");
  pick("decor", DECOR_TIERS, "decorType");
  pick("catering", CATERING_BANDS, "cateringType");
  if (b.roomBand !== undefined) {
    const band = ROOM_BANDS.find((row) => row.id === String(b.roomBand));
    if (band) out.roomBand = band.id;
  }
  if (b.rooms !== undefined && b.rooms !== null && b.rooms !== "") {
    const n = Number(b.rooms);
    if (Number.isFinite(n) && n >= 0) out.rooms = Math.min(500, Math.floor(n));
  }
  if (Array.isArray(b.services)) {
    const known = new Set(SERVICES.map((service) => service.id));
    out.services = b.services.map((id) => String(id)).filter((id) => known.has(id));
  } else if (b.services && typeof b.services === "object") {
    out.services = {};
    SERVICES.forEach((service) => {
      if (b.services[service.id]) out.services[service.id] = true;
    });
  }
  return out;
};

/**
 * The target the couple commits to. Whole rupees, never negative, and capped
 * at ₹100 crore — a target with eleven digits is a typo, and it would draw
 * every bar on the tracker at zero.
 */
const targetFrom = (body) => {
  const raw = body && (body.target !== undefined ? body.target : body.amount);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const value = Math.round(n);
  return value > 1000000000 ? null : value;
};

module.exports = {
  VENUE_TYPES,
  DECOR_TIERS,
  CATERING_BANDS,
  SERVICES,
  ROOM_BANDS,
  ROOM_NIGHT_RATE,
  DEFAULT_ANSWERS,
  CATEGORIES,
  buildEstimate,
  estimateAnswers,
  targetFrom,
  chosenDays,
  chosenServices,
  roomsFor,
  money,
};

/**
 * utils/venueRoomTypes.js — the one place room-type inheritance and the
 * listing projection are decided.
 *
 * ── THE RECONCILIATION ──────────────────────────────────────────────────────
 * Two rooms structures existed and neither was right:
 *
 *   accommodation.roomTypes[]  marketing copy. Name, a COUNT, occupancy, a
 *                              price. Read by the couple-facing listing at
 *                              wedsy-user/pages/venues/[slug].js. No rooms.
 *   rooms[]                    operational inventory. Real rooms with names,
 *                              used by allotment and check-in. No type entity,
 *                              no amenities, no rate.
 *
 * Neither is promoted into the other. `roomTypes[]` is a NEW top-level entity —
 * what a Deluxe IS — and `rooms[]` belong to it via `typeRef`. The marketing
 * block becomes DERIVED from those two, by `projectAccommodation` below, so:
 *
 *   • the listing keeps reading exactly the fields it reads today
 *   • its `count` stops being a number the owner retypes and starts being the
 *     number of rooms that actually exist
 *   • there is one editable source of truth instead of two that drift
 *
 * The alternative — promoting accommodation.roomTypes in place — forces a
 * choice between dropping `count` (breaking the listing) and keeping it beside
 * real rooms as a second tally of the same thing. That is the drift we are
 * removing, so it was not an option.
 *
 * ── AND THE SAFETY PROPERTY ─────────────────────────────────────────────────
 * Projection is OPT-IN, gated on the venue having defined at least one
 * roomType. A venue that has not adopted the new model keeps its hand-written
 * accommodation block byte for byte. Today that is every venue in production.
 */

/**
 * Room fields that inherit from the type. The room's own column is authoritative
 * ONLY when the field name appears in `room.overrides`.
 *
 * `capacity` reads from the type's `sleeps`: the operational field and the
 * marketing field are the same fact under two names, and allotment already
 * reads `capacity`.
 */
const INHERITABLE = [
  { field: "capacity", from: (t) => num(t.sleeps, 2) },
  { field: "amenities", from: (t) => (t.amenities || []).map(String) },
  { field: "rate", from: (t) => num(t.defaultRate, 0) },
];
const INHERITABLE_FIELDS = INHERITABLE.map((i) => i.field);

/** The amenity key that means air conditioning, for the listing's `isAC`. */
const AC_KEY = "ac";

/**
 * The four clusters an owner thinks in while deciding what a Deluxe is. Order
 * matters — it is the order they are offered in, and "extras" is deliberately
 * last because it is the bucket for everything that did not fit.
 */
const AMENITY_GROUPS = ["comfort", "bathroom", "entertainment", "extras"];
const AMENITY_GROUP_LABEL = {
  comfort: "Comfort",
  bathroom: "Bathroom",
  entertainment: "Entertainment",
  extras: "Extras",
};

/**
 * The starting library. Owners extend it; it is not an enum.
 *
 * ── WHAT THE BAR FOR INCLUSION IS ───────────────────────────────────────────
 * A venue looking at a near-empty picker types four things and stops. Every
 * entry here is one an owner would otherwise have to think of unprompted, so
 * the test is "a mid-range Indian property would tick this without hesitating",
 * not "some hotel somewhere has one". Ten was too few to prompt with.
 *
 * ── AND WHAT THIS LIST IS NOT ───────────────────────────────────────────────
 * A SEED. It is copied into the venue's own `roomAmenities` on first use, and
 * what an owner adds afterwards is THEIRS: it stays on their venue and is never
 * promoted anywhere. There is no master list here, and deliberately no path
 * from a venue's custom amenity to one — OS-side curation is a separate build
 * with its own coordination, and nothing in this file should grow towards it.
 */
const DEFAULT_ROOM_AMENITIES = [
  // Comfort — what decides whether a room is pleasant to sleep in.
  { key: "ac", label: "Air conditioning", group: "comfort" },
  { key: "wardrobe", label: "Wardrobe", group: "comfort" },
  { key: "balcony", label: "Balcony", group: "comfort" },
  { key: "extra_bed", label: "Extra bed available", group: "comfort" },
  { key: "desk", label: "Work desk", group: "comfort" },
  { key: "iron", label: "Iron and board", group: "comfort" },

  // Bathroom — where a wedding party notices the difference first.
  { key: "attached_bath", label: "Attached bathroom", group: "bathroom" },
  { key: "hot_water", label: "Hot water", group: "bathroom" },
  { key: "geyser", label: "Geyser", group: "bathroom" },
  { key: "bathtub", label: "Bathtub", group: "bathroom" },
  { key: "toiletries", label: "Toiletries", group: "bathroom" },
  { key: "towels", label: "Towels", group: "bathroom" },
  { key: "bathrobe", label: "Bathrobe", group: "bathroom" },
  { key: "hairdryer", label: "Hairdryer", group: "bathroom" },

  { key: "wifi", label: "Wi-Fi", group: "entertainment" },
  { key: "tv", label: "Television", group: "entertainment" },

  { key: "room_service", label: "Room service", group: "extras" },
  { key: "mini_fridge", label: "Mini fridge", group: "extras" },
  { key: "minibar", label: "Minibar", group: "extras" },
  { key: "kettle", label: "Kettle", group: "extras" },
  { key: "locker", label: "In-room locker", group: "extras" },
];

/** Group for an amenity that has none stored. See the model for why. */
const SEED_GROUP_BY_KEY = new Map(DEFAULT_ROOM_AMENITIES.map((a) => [a.key, a.group]));
function resolveGroup(amenity) {
  const stored = String((amenity && amenity.group) || "").trim();
  if (stored) return stored;
  return SEED_GROUP_BY_KEY.get(String(amenity && amenity.key)) || "extras";
}

/**
 * ── WHY roomAmenities IS A NEW LIST AND NOT Venue.amenities ─────────────────
 * `Venue.amenities` (models/Venue.js:190) is a fixed OBJECT OF BOOLEANS about
 * the PROPERTY: swimmingPool, helipad, garden, fireNOC, liquorLicense,
 * valetParking, shuttleService. It has no keys and no labels, and the
 * couple-facing venue search filters straight off its field names —
 * wedsy-user/pages/venues/index.js:170 says so in as many words: "Amenity
 * filter keys must match the venue.amenities schema so filtering works without
 * a translation step."
 *
 * Widening it would run both ways and both are wrong: "helipad" and "fire NOC"
 * would appear in a room's amenity picker, and "attached bathroom" would appear
 * in the public venue-search filter bar. It is also a fixed schema, so an owner
 * could not add anything to it without a code change — which is precisely what
 * this list has to allow.
 *
 * So: reused nothing, replaced nothing. A separate list, on purpose.
 */

/** Machine key from a label. Stable, lowercase, no leading/trailing fill. */
function amenityKeyFor(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * Where an amenity key is actually used, so removing one can say what it would
 * affect instead of just doing it.
 */
function amenityUsage(venue, key) {
  const k = String(key);
  const types = (venue.roomTypes || []).filter((t) => (t.amenities || []).map(String).includes(k));
  const rooms = (venue.rooms || []).filter(
    (r) => (r.overrides || []).map(String).includes("amenities") && (r.amenities || []).map(String).includes(k)
  );
  return { types: types.map((t) => t.name), rooms: rooms.map((r) => r.name) };
}

/**
 * A type's photos as plain URLs, cover first, otherwise in the owner's order.
 *
 * Tolerates a bare string as well as {url}, because the field was [String]
 * before this build. Nothing in production holds either — zero venues have
 * adopted the new room types — but a shape assumption that is true only because
 * a collection happens to be empty is one that breaks the day it is not.
 */
function coverFirstUrls(photos) {
  const rows = (photos || [])
    .map((p) => (typeof p === "string" ? { url: p, isCover: false } : p || {}))
    .filter((p) => p.url);
  const cover = rows.filter((p) => p.isCover);
  const rest = rows.filter((p) => !p.isCover);
  return [...cover, ...rest].map((p) => String(p.url));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const idOf = (v) => (v === null || v === undefined ? "" : String(v._id || v));

function findType(venue, typeRef) {
  const want = idOf(typeRef);
  if (!want) return null;
  return (venue.roomTypes || []).find((t) => idOf(t._id) === want) || null;
}

/**
 * The effective room: what it IS after inheritance, plus what it has diverged
 * on. Callers that need a room's real capacity/amenities/rate read this, never
 * the raw subdoc — a room with no override carries a stale column by design.
 */
function resolveRoom(room, type) {
  const overrides = new Set((room.overrides || []).map(String));
  const out = {
    _id: room._id,
    name: room.name,
    typeRef: room.typeRef || null,
    typeName: type ? type.name : "",
    type: room.type,
    notes: room.notes || "",
    isActive: room.isActive !== false,
    overrides: Array.from(overrides),
    inherited: [],
  };
  // ── THE OVERRIDE HAS TO BE VISIBLE ON THE ROOM ─────────────────────────────
  // Not just "this is 9500" but "this is 9500, the type says 4500, and you can
  // put it back". Without the type's value beside it, an owner cannot tell a
  // deliberate divergence from a stale number, which is the same ambiguity
  // `overrides` exists to remove — it would just have moved to the screen.
  out.fields = {};
  for (const { field, from } of INHERITABLE) {
    const own = room[field];
    const ownValue = field === "amenities" ? (own || []).map(String) : num(own, field === "capacity" ? 2 : 0);
    if (!type) {
      // A one-off room, from before types existed or deliberately untyped.
      // Nothing to inherit from, so its own column IS the value.
      out[field] = ownValue;
      out.fields[field] = { value: ownValue, source: "room", typeValue: null, overridden: false };
      continue;
    }
    const typeValue = from(type);
    if (overrides.has(field)) {
      out[field] = ownValue;
      out.fields[field] = { value: ownValue, source: "room", typeValue, overridden: true };
    } else {
      out[field] = typeValue;
      out.inherited.push(field);
      out.fields[field] = { value: typeValue, source: "type", typeValue, overridden: false };
    }
  }
  return out;
}

/**
 * Resolve amenity keys to labels for display, and say which have been retired
 * from the library. A key whose amenity was removed still resolves — the room
 * genuinely has the thing; the venue simply stopped offering it as a choice —
 * so it renders with a flag rather than vanishing from the room silently.
 */
function describeAmenities(venue, keys) {
  const known = new Map((venue.roomAmenities || []).map((a) => [String(a.key), a]));
  return (keys || []).map((k) => {
    const key = String(k);
    const found = known.get(key);
    return {
      key,
      label: found ? found.label : key,
      retired: !found || found.isActive === false,
      unknown: !found,
    };
  });
}

function resolveRooms(venue) {
  return (venue.rooms || []).map((r) => {
    const out = resolveRoom(r, findType(venue, r.typeRef));
    out.amenityDetail = describeAmenities(venue, out.amenities);
    return out;
  });
}

/**
 * Push a type's current values down onto its rooms, skipping every field a
 * room has overridden. Mutates the subdocs; the caller saves.
 *
 * This is why `overrides` is stored as a list of NAMES rather than inferred by
 * comparing a room's value to its type's. Inference cannot tell "deliberately
 * 3" from "was 3 back when the type said 3" — so the first type edit would
 * either clobber real intent or freeze rooms that never diverged.
 */
function applyTypeToRooms(venue, type) {
  const want = idOf(type && type._id);
  let touched = 0;
  for (const room of venue.rooms || []) {
    if (idOf(room.typeRef) !== want) continue;
    const overrides = new Set((room.overrides || []).map(String));
    for (const { field, from } of INHERITABLE) {
      if (overrides.has(field)) continue;
      room[field] = from(type);
    }
    touched += 1;
  }
  return touched;
}

/**
 * Derive the couple-facing accommodation block from types + real rooms.
 *
 * Writes ONLY the fields wedsy-user/pages/venues/[slug].js reads:
 *   name, count, occupancyPerRoom, maxPeoplePerRoom, pricePerNight, isAC,
 *   sizeSqFt, bedConfiguration, view (ROOMS 4 — only when stated),
 *   description, photos — plus accommodation.totalCapacity and .available,
 *   which the same page derives its headline numbers from.
 *
 * Returns { changed, rows, untyped } — `untyped` is the count of active rooms
 * belonging to no type. Those are deliberately NOT folded into a made-up row:
 * the listing would gain copy nobody wrote. It is returned so the page can tell
 * the owner they exist and are invisible to couples.
 */
function projectAccommodation(venue) {
  const types = (venue.roomTypes || []).filter((t) => t.isActive !== false);
  if (!(venue.roomTypes || []).length) {
    // Not adopted. The hand-written block stands untouched.
    return { changed: false, rows: null, untyped: 0, skipped: "no-room-types" };
  }

  const library = new Set((venue.roomAmenities || []).map((a) => String(a.key)));
  const acKnown = library.has(AC_KEY);

  const activeRooms = (venue.rooms || []).filter((r) => r.isActive !== false);
  const countByType = new Map();
  for (const r of activeRooms) {
    const k = idOf(r.typeRef);
    if (!k) continue;
    countByType.set(k, (countByType.get(k) || 0) + 1);
  }

  const rows = types.map((t) => {
    const amenities = new Set((t.amenities || []).map(String));
    const sleeps = Math.max(1, num(t.sleeps, 2));
    return {
      name: t.name,
      count: countByType.get(idOf(t._id)) || 0,
      occupancyPerRoom: sleeps,
      // The listing shows a ceiling; a type that has not set one means "no
      // extra beds", which is `sleeps`, not zero.
      maxPeoplePerRoom: Math.max(sleeps, num(t.maxOccupancy, 0)),
      pricePerNight: num(t.defaultRate, 0),
      // Only assert non-AC when the venue's library can actually express AC.
      // Otherwise the owner has no way to say yes, and silence is not a no —
      // fall back to the schema default rather than mislabel every room.
      isAC: acKnown ? amenities.has(AC_KEY) : true,
      description: t.description || "",
      // ── COVER FIRST, THEN THE OWNER'S ORDER ──────────────────────────────
      // The public block stays a flat [String]: that is what the listing reads,
      // and a shape change there would be a change to the couple-facing
      // contract. The cover leads because the listing shows photos[0] on the
      // card, so "which photo represents this type" has to survive the flatten.
      photos: coverFirstUrls(t.photos),
      // ── ROOMS 4: ONLY WHAT THE OWNER STATED ─────────────────────────────
      // Spread conditionally rather than written as 0/"" so a venue that fills
      // none of these produces a row with the SAME KEYS it had before this
      // build. The listing renders each only when present, so an absent field
      // and an empty one look identical on screen — but they are not identical
      // in the document, and the byte-identical assertion in the suite is what
      // keeps that honest.
      ...(num(t.sizeSqFt, 0) > 0 ? { sizeSqFt: num(t.sizeSqFt, 0) } : {}),
      ...(String(t.bedConfiguration || "").trim()
        ? { bedConfiguration: String(t.bedConfiguration).trim() }
        : {}),
      ...(String(t.view || "").trim() ? { view: String(t.view).trim() } : {}),
      // `accessible: false` is a real answer ("not step-free"), so this tests
      // for PRESENCE, not truthiness — `t.accessible && …` would silently drop
      // the venues that answered honestly no.
      ...(t.smokingPolicy ? { smokingPolicy: t.smokingPolicy } : {}),
      ...(t.accessible === true || t.accessible === false ? { accessible: t.accessible } : {}),
    };
  });

  const totalRooms = rows.reduce((s, r) => s + r.count, 0);
  // ── THE FORMULA IS NOT A CHOICE ────────────────────────────────────────────
  // count × maxPeoplePerRoom, because two live consumers already compute it
  // that way and a different formula would move numbers on screen:
  //
  //   wedsy-user/pages/venues/[slug].js:883   accTotalCap falls back to
  //     Σ count × (maxPeoplePerRoom || occupancyPerRoom) when totalCapacity is
  //     unset — which is the state of every accommodation venue in production
  //     today. Writing a DIFFERENT number here would take precedence over that
  //     fallback and change the couple-facing "Total capacity: N guests" line.
  //
  //   wedsy-venue .../dashboard/listing/page.tsx:637  the owner's own editor
  //     shows and saves exactly Σ count × maxPeoplePerRoom.
  //
  // It also feeds VenueRepository's `capacity` sort, so an invented number
  // would reorder public search results.
  const totalCapacity = rows.reduce((s, r) => s + r.count * (r.maxPeoplePerRoom || r.occupancyPerRoom || 0), 0);

  venue.accommodation = venue.accommodation || {};
  venue.accommodation.roomTypes = rows;
  venue.accommodation.totalCapacity = totalCapacity;
  // `available` is deliberately NOT derived. It is the owner's toggle for
  // whether to advertise rooms to couples at all — a marketing decision, not a
  // fact about the inventory. A venue can hold back-of-house rooms it never
  // sells. Deriving it from the room count would silently re-advertise
  // accommodation an owner had turned off, every time they edited a room.

  const untyped = activeRooms.filter((r) => !idOf(r.typeRef)).length;
  return { changed: true, rows, untyped, totalRooms, totalCapacity };
}

/* ══ THE TWO PRESENTERS ═══════════════════════════════════════════════════════
 * Both of these lived in controllers/venueRoomTypes.js, which meant every OTHER
 * controller that returned the same data returned a DIFFERENT SHAPE of it.
 * Measured on main, before this build:
 *
 *   GET /room-types   roomAmenities through presentAmenities  → group, usage,
 *                                                               usedBefore
 *   GET /room-setup   venue.roomAmenities RAW                 → none of them
 *
 * So the amenity picker inside the WIZARD lost `usedBefore` ordering, and any
 * amenity created before `group` existed fell through the client's
 * `a.group ?? "extras"` fallback into Extras — while the same picker under Edit
 * property grouped it correctly. One concept, two shapes, and the divergence was
 * invisible because both endpoints "returned the amenities".
 *
 * They live here now so a third caller cannot reintroduce the split. Nothing may
 * return roomAmenities or roomTypes except through these.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * The amenity library, grouped and ordered, with what each one is used by.
 *
 * ── AMENITIES ARE ALWAYS PRESENTED WITH THEIR USAGE ─────────────────────────
 * Only the LIST endpoint attached `usage`; the five write endpoints returned a
 * bare array. The Amenities screen merges whatever a write returns into its
 * state, so the moment an owner added or renamed anything, every row lost its
 * usage and read "Not used yet" — including amenities the Standard type was
 * visibly using two inches away.
 *
 * One presenter, used by every response that carries amenities, so a sixth
 * endpoint cannot forget.
 */
function presentAmenities(venue) {
  const rows = (venue.roomAmenities || []).map((a) => {
    const usage = amenityUsage(venue, a.key);
    return {
      key: a.key,
      label: a.label,
      isActive: a.isActive !== false,
      group: resolveGroup(a),
      usage,
      /**
       * ── FLOAT WHAT THE OWNER HAS ALREADY REACHED FOR ────────────────────
       * An amenity already on some type is one this venue genuinely has, and
       * is far more likely to be wanted on the next type than the twelfth item
       * of a starter list. Surfaced as a FLAG rather than by pre-sorting the
       * array, so a screen can float them WITHIN their group and keep the
       * grouping intact — sorting them all to the top instead would put
       * "Attached bathroom" above the Comfort heading.
       */
      usedBefore: usage.types.length > 0,
    };
  });

  // Stable order: group first (in AMENITY_GROUPS order), used-before next,
  // then the order the owner created them. Nothing is sorted alphabetically —
  // a list an owner has arranged should stay arranged.
  const groupRank = new Map(AMENITY_GROUPS.map((g, i) => [g, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ga = groupRank.has(a.r.group) ? groupRank.get(a.r.group) : AMENITY_GROUPS.length;
      const gb = groupRank.has(b.r.group) ? groupRank.get(b.r.group) : AMENITY_GROUPS.length;
      if (ga !== gb) return ga - gb;
      if (a.r.usedBefore !== b.r.usedBefore) return a.r.usedBefore ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * Which ACTIVE rooms are of this type.
 *
 * Active only, and that is the whole subtlety. A deactivated room still carries
 * `typeRef`, so counting every room would let a property whose Deluxes were all
 * taken out of service report the type as "in use" forever — retiring it instead
 * of deleting it, permanently, with no way for the owner to reach the other
 * outcome. Deactivated rooms are not on the property; they do not keep a type
 * alive.
 */
function typeUsage(venue, typeId) {
  const id = String(typeId);
  return (venue.rooms || [])
    .filter((r) => r.isActive !== false && String(r.typeRef || "") === id)
    .map((r) => r.name);
}

/**
 * Room types, each carrying WHAT DELETE WILL DO TO IT.
 *
 * ── WHY THE VERDICT RIDES ON THE READ ──────────────────────────────────────
 * The same reason it does for rooms (see utils/venueRoomDeletion): a screen that
 * offers Delete and is then contradicted has already failed. The owner has to be
 * able to read "this one retires rather than goes, because six rooms are it"
 * BEFORE committing to anything.
 *
 * `deleteAction` is deliberately not a boolean. Types have two outcomes and both
 * are successes — `deletable: false` would be a lie about the in-use case, which
 * does not refuse, it retires. Naming the ACTION rather than the permission is
 * what lets the drawer word its own button honestly.
 */
function presentTypes(venue) {
  return (venue.roomTypes || []).map((t) => {
    const obj = typeof t.toObject === "function" ? t.toObject() : { ...t };
    const rooms = typeUsage(venue, t._id);
    return {
      ...obj,
      usage: { rooms },
      deleteAction: rooms.length ? "retire" : "delete",
    };
  });
}

module.exports = {
  INHERITABLE_FIELDS,
  coverFirstUrls,
  AMENITY_GROUPS,
  AMENITY_GROUP_LABEL,
  resolveGroup,
  amenityKeyFor,
  amenityUsage,
  presentAmenities,
  typeUsage,
  presentTypes,
  describeAmenities,
  DEFAULT_ROOM_AMENITIES,
  AC_KEY,
  findType,
  resolveRoom,
  resolveRooms,
  applyTypeToRooms,
  projectAccommodation,
};

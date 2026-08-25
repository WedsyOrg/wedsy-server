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

/** The starting library. Owners extend it; it is not an enum. */
const DEFAULT_ROOM_AMENITIES = [
  { key: "ac", label: "Air conditioning" },
  { key: "attached_bath", label: "Attached bathroom" },
  { key: "hot_water", label: "Hot water" },
  { key: "wifi", label: "Wi-Fi" },
  { key: "tv", label: "Television" },
  { key: "wardrobe", label: "Wardrobe" },
  { key: "balcony", label: "Balcony" },
  { key: "extra_bed", label: "Extra bed available" },
  { key: "room_service", label: "Room service" },
  { key: "mini_fridge", label: "Mini fridge" },
];

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
  for (const { field, from } of INHERITABLE) {
    const own = room[field];
    if (!type) {
      // A one-off room, from before types existed or deliberately untyped.
      // Nothing to inherit from, so its own column IS the value.
      out[field] = field === "amenities" ? (own || []).map(String) : num(own, field === "capacity" ? 2 : 0);
      continue;
    }
    if (overrides.has(field)) {
      out[field] = field === "amenities" ? (own || []).map(String) : num(own, 0);
    } else {
      out[field] = from(type);
      out.inherited.push(field);
    }
  }
  return out;
}

function resolveRooms(venue) {
  return (venue.rooms || []).map((r) => resolveRoom(r, findType(venue, r.typeRef)));
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
      photos: (t.photos || []).map(String),
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

module.exports = {
  INHERITABLE_FIELDS,
  DEFAULT_ROOM_AMENITIES,
  AC_KEY,
  findType,
  resolveRoom,
  resolveRooms,
  applyTypeToRooms,
  projectAccommodation,
};

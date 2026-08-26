const mongoose = require("mongoose");
const venueTracks = require("../utils/venueTracks");

// ---------------------------------------------------------------------------
// coverPhoto durability guard
//
// Rejects raw Google Places Photo endpoint URLs — the shape that embeds an API
// key and breaks permanently when that key rotates:
//   https://maps.googleapis.com/maps/api/place/photo?...&key=<KEY>
//
// Durable URLs are unaffected: lh3.googleusercontent.com (the resolved target),
// image.wedmegood.com, *.cloudfront.net, *.s3.*.amazonaws.com all pass, as do
// "" (the schema default) and unset.
//
// NOTE: this is a narrow, interim guard aimed at one known failure mode. The
// broader "coverPhoto must be a Wedsy-owned S3 asset" rule is specced separately
// and lands with the S3 migration; this is deliberately not that.
// ---------------------------------------------------------------------------
const RAW_PLACES_PHOTO_RE = /maps\.googleapis\.com\/maps\/api\/place\/photo/i;

function isDurableCoverPhoto(value) {
  if (value === undefined || value === null || value === "") return true;
  return !RAW_PLACES_PHOTO_RE.test(String(value));
}

const VenueSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  tagline: { type: String, default: "" },
  description: { type: String, default: "" },
  venueType: { type: String, enum: ["resort", "farmhouse", "villa", "hotel", "heritage", "banquet_hall", "club", "other"], default: "resort" },
  established: { type: Number },
  city: { type: String, default: "Bangalore" },
  address: { type: String, default: "" },
  location: { type: { type: String }, coordinates: [Number] },
  locationDescription: { type: String, default: "" },
  // Coarse Bangalore region — drives the zone tabs on the public browse page.
  // Computed by utils/enrichVenue.js from Google-resolved coordinates (or
  // address as fallback). "" is the not-yet-classified sentinel.
  zone: { type: String, enum: ["north", "south", "east", "west", "central", "airport", ""], default: "" },
  // Neighbourhood label — Google sublocality_level_1 (or fallback). Powers the
  // area free-text search alongside venue.address.
  locality: { type: String, default: "" },
  // Up to 10 final image URLs resolved from Google Places photo_references.
  googlePhotos: [{ type: String }],
  // When the Google enrichment was last run for this venue. Drives the
  // 7-day staleness check in scripts/enrich-venues-google.js.
  enrichedAt: { type: Date },
  areas: [{ type: String }],
  state: { type: String },
  pincode: { type: String },
  formattedAddress: { type: String },
  spaces: [{
    name: String,
    type: { type: String, enum: ["indoor", "outdoor", "semi-outdoor"] },
    capacitySeated: { type: Number, default: 0 },
    capacityStanding: { type: Number, default: 0 },
    bestFor: [String],
    description: { type: String, default: "" },
    photos: [String],
    // D3 date-inventory (additive): whether this space participates in the
    // holds/booking calendar. Listing-only display spaces set false.
    isBookable: { type: Boolean, default: true },
  }],
  accommodation: {
    available: { type: Boolean, default: false },
    totalCapacity: { type: Number, default: 0 },
    // ══ THE PUBLIC PROJECTION — NOT THE OPERATIONAL MODEL ══════════════════
    // ⚠ THERE ARE TWO `roomTypes` ARRAYS IN THIS FILE. This is the one the
    // COUPLE-FACING LISTING reads (wedsy-user/pages/venues/[slug].js:879-883).
    // It is DERIVED — written only by utils/venueRoomTypes.projectAccommodation
    // — and its field names are a public contract: name, count,
    // occupancyPerRoom, maxPeoplePerRoom, pricePerNight, isAC, description,
    // photos (a flat [String], cover first).
    //
    // `totalCapacity` above also SORTS PUBLIC VENUE SEARCH
    // (repositories/VenueRepository.js:19), so a number invented here reorders
    // results for every couple.
    //
    // The operational model — the one an owner edits — is `roomTypes` at the
    // TOP LEVEL of this schema, further down. The two have near-identical
    // field lists, so a single-occurrence find-and-replace aimed at one will
    // silently hit the other. Check which you are in before editing.
    roomTypes: [{
      name: String,
      count: { type: Number, default: 0 },
      occupancyPerRoom: { type: Number, default: 2 },
      maxPeoplePerRoom: { type: Number, default: 2 },
      pricePerNight: { type: Number, default: 0 },
      isAC: { type: Boolean, default: true },
      description: { type: String, default: "" },
      photos: [String],
      // ROOMS 4 (additive), and DELIBERATELY WITHOUT DEFAULTS.
      //
      // A default here defeats the whole point: mongoose fills it in on every
      // row it casts, so a venue that never stated a size would still store
      // `sizeSqFt: 0` — turning "not stated" into "stated as zero", the exact
      // distinction derive-nothing-typed-literally exists to protect. Caught by
      // the suite asserting the stored key set, which is the only place this
      // shows: the projection's conditional spread was correct and was being
      // undone one layer down.
      //
      // With no default, an omitted field stays omitted in the document, and
      // the listing's `rt.sizeSqFt && …` guard reads absent and zero the same
      // way — which is right, because a room of no size is not a thing.
      sizeSqFt: { type: Number },
      bedConfiguration: { type: String },
      view: { type: String },
      /**
       * ROOMS 6. An ENUM, not a boolean, because both answers are positive
       * claims a couple looks for — "non-smoking" is something a venue
       * advertises, not merely the absence of "smoking". A boolean would make
       * `false` carry that claim, and absent and false would then be one step
       * apart in the data and worlds apart in meaning.
       *
       * No defaults, for the reason sizeSqFt has none: a default writes an
       * answer nobody gave, and a venue that has stated nothing must render
       * exactly as it does today.
       */
      smokingPolicy: { type: String, enum: ["smoking", "non_smoking"] },
      /** Genuinely binary: step-free and usable, or not. Absent = not stated. */
      accessible: { type: Boolean },
    }],
  },
  // ══ THE ROOM-AMENITIES LIBRARY ═══════════════════════════════════════════
  // Venue-level, defined ONCE, referenced by types and rooms by KEY. Seeded
  // from a starting set the owner extends rather than a fixed enum: every venue
  // has something the list did not anticipate, and an enum makes that a schema
  // change.
  //
  // NOT the same thing as `amenities` above. That block describes the PROPERTY
  // — parking, power backup, a lawn — and is what the listing advertises. This
  // describes what is inside a ROOM. Widening the existing block would have put
  // "parking" in a room's amenity picker, so this is a new list, not a reuse.
  roomAmenities: [{
    /** Stable machine key. Types and rooms reference this, never the label. */
    key: { type: String, required: true },
    label: { type: String, required: true },
    /**
     * Which cluster this sits in when an owner is deciding what a Deluxe is:
     * comfort / bathroom / entertainment / extras. Free text rather than an
     * enum for the same reason the list itself is not an enum — a venue will
     * have a grouping nobody anticipated — but the UI only offers the four.
     *
     * DEFAULTS TO EMPTY, NOT TO "extras". Amenities created before this field
     * existed have no group, and writing one in would be a migration. The
     * presenter resolves an empty group from the seed catalogue by key — which
     * is not inference about the OWNER'S text, it is recovering the group WE
     * assigned when WE seeded it — and falls to "extras" for anything else.
     */
    group: { type: String, default: "", maxlength: 40 },
    /** False once removed; kept so rooms that still reference it resolve. */
    isActive: { type: Boolean, default: true },
  }],

  // ══ THE ROOM TYPE — A REAL ENTITY ════════════════════════════════════════
  // What a Deluxe IS: how many it sleeps, what is in it, what it costs, what it
  // looks like. Rooms belong to a type and inherit from it.
  //
  // ── WHY A NEW ARRAY RATHER THAN PROMOTING accommodation.roomTypes ─────────
  // That block carries `count` — a NUMBER of rooms, not the rooms themselves.
  // Promoting it would mean either dropping `count` (breaking the couple-facing
  // listing, which reads it) or keeping it beside real rooms as a second,
  // divergent tally of the same thing. The listing block is now DERIVED from
  // this array plus the real room count, so there is one editable source and
  // the listing's numbers get MORE accurate rather than less.
  // See utils/venueRoomTypes.projectAccommodation.
  // ⚠ THE OPERATIONAL MODEL — NOT the public projection. See the OTHER
  // `roomTypes` array, inside `accommodation` above: that one is derived from
  // this one and is what couples read. The two have near-identical field lists
  // and a single-occurrence replace aimed at one will silently hit the other.
  roomTypes: [{
    name: { type: String, required: true },
    /** How many it sleeps — the listing's occupancyPerRoom. */
    sleeps: { type: Number, default: 2, min: 1 },
    /** Ceiling with extra beds; falls back to `sleeps` when 0. */
    maxOccupancy: { type: Number, default: 0 },
    /**
     * ── WHAT A COUPLE ACTUALLY DECIDES ON ─────────────────────────────────
     * All optional, all empty by default: a venue that fills none of them must
     * render exactly as it does today, so "" and 0 mean UNSET rather than a
     * value, and the projection omits them entirely.
     */
    /** Floor area in square feet. 0 means not stated, not a room of no size. */
    sizeSqFt: { type: Number, default: 0, min: 0 },
    /**
     * ROOMS 6 — two things couples actually ask about.
     *
     * Both UNSET by default and both tri-state: not stated / yes / no. A venue
     * that has never answered must not be made to claim either, which is why
     * neither has a default and why smoking is an enum rather than a boolean —
     * "non-smoking" is a claim, not the absence of one.
     */
    smokingPolicy: { type: String, enum: ["smoking", "non_smoking"] },
    accessible: { type: Boolean },
    /**
     * FREE TEXT, NOT A FIXED LIST — "1 king", "2 twins, can be joined",
     * "1 king + 1 sofa bed". Audited before choosing: nothing on the couple
     * side consumes this structurally. Venue search filters on venue-level
     * `amenities.*`, zone, type, name, dietary options, spaces.capacitySeated
     * and per-plate price — nothing room-type-level — so a fixed list would buy
     * no facet and no filter.
     *
     * Which leaves only the question of whether OUR list reads better to a
     * couple than the owner's own words, and for "2 twins, can be joined" it
     * plainly does not. If search ever wants a bed facet, that is the moment to
     * add structure ALONGSIDE this, not to have pre-emptively flattened what
     * owners wrote into whichever options we guessed at.
     */
    bedConfiguration: { type: String, default: "", maxlength: 200 },
    /**
     * Also free text, and for the same reason — "garden", "lake, from the
     * balcony only", "courtyard". Resorts price on this and the qualifier is
     * usually the point. The owner-side offers common ones as one-tap fills
     * that populate the field; what is stored is still what they typed.
     */
    view: { type: String, default: "", maxlength: 120 },
    /** Keys into roomAmenities. Rooms inherit this set. */
    amenities: [{ type: String }],
    /**
     * The nightly rate a room of this type defaults to. NOT wired into any
     * booking total — that is the next build, and it needs this entity to exist
     * first. Stored here so there is one place it will come from.
     */
    defaultRate: { type: Number, default: 0, min: 0 },
    description: { type: String, default: "" },
    /**
     * ── PHOTOS: ORDERED, WITH ONE COVER ──────────────────────────────────
     * The single biggest driver of a booking decision, and until now nowhere
     * in the operational model.
     *
     * ORDER IS THE ARRAY, as it is for blocks and floors — reordering rewrites
     * it, and there is no index field to drift out of step with it.
     *
     * COVER IS EXPLICIT, and deliberately NOT "whichever is first". Were the
     * cover position 0, reordering the gallery would silently change the one
     * photo a couple sees on the card — the higher-stakes of the two facts.
     * "What order do these go in" and "which one represents this type" are
     * different questions, so they are different fields, and the one-cover
     * invariant is enforced by the controller rather than hoped for.
     *
     * NOTE the public projection keeps `photos: [String]` — see
     * utils/venueRoomTypes.projectAccommodation. A flat, cover-first list of
     * URLs is what a listing wants, and changing that shape would be a change
     * to the couple-facing contract for no gain.
     */
    photos: [{
      url: { type: String, required: true, maxlength: 2000 },
      isCover: { type: Boolean, default: false },
    }],
    isActive: { type: Boolean, default: true },
  }],

  // ══ HOW THIS VENUE SELLS ITS ROOMS ═══════════════════════════════════════
  // "Some resorts might give rooms on a daily basis and some might not and only
  // during event they give out the entire property."
  //
  // PRICE IS NOT A PROPERTY OF THE ROOM. It is a property of how the room is
  // being SOLD — the same suite is included in one deal and charged in the
  // next. So none of this lives on the room or the type: the type's
  // `defaultRate` answers "what does this room cost per night" and is PUBLIC
  // (it becomes accommodation.roomTypes[].pricePerNight on the listing); this
  // answers "what do extra rooms cost when bundled into a venue booking",
  // which is a different sale.
  //
  // ── NO DEFAULTS, DELIBERATELY ────────────────────────────────────────────
  // A default here would write an answer nobody gave, and "never set up" has to
  // stay distinguishable from "set up as all-included" — they look identical in
  // their effect on money (nothing is charged) but they are not the same fact,
  // and only one of them should show an owner a policy they never wrote.
  //
  // Reading goes through utils/venueRoomsPolicy.resolvePolicy, which always
  // returns the same shape with `configured` telling the two apart — the same
  // pattern as resolveLayout, and for the same reason.
  roomsPolicy: {
    /** Has the owner actually answered these questions? */
    configured: { type: Boolean },
    /** Are rooms sold nightly, outside events? Most wedding resorts: no. */
    sellsNightly: { type: Boolean },
    /** How many rooms come with the venue hire. */
    includedWithVenue: { type: String, enum: ["all", "none", "count"] },
    /** Only meaningful when includedWithVenue is "count". */
    includedCount: { type: Number, min: 0 },
    /**
     * What an EXTRA room costs, per room per night, on a venue booking.
     * Unset falls back to the room type's own defaultRate — and the booking
     * line says which one it used, so a number never appears without a source.
     */
    extraRoomRate: { type: Number, min: 0 },
    /**
     * What ONE extra bed costs, per bed per night. Set here beside the
     * extra-room rate because it answers the same commercial question — what
     * the venue charges on top of a booking — and an owner setting one will
     * look for the other in the same place.
     *
     * Unset means extra beds are free, which is what they are today. It does
     * NOT fall back to the room rate: a rollaway is not a room, and inferring
     * one price from the other would invent a number nobody agreed.
     */
    extraBedRate: { type: Number, min: 0 },
  },

  // ══ FIRST-RUN SETUP — ONLY WHAT CANNOT BE DERIVED ════════════════════════
  // The wizard is RESUMABLE, and the cheapest way to be resumable is to have
  // almost no state: which step an owner is on is a function of what they have
  // actually built. Blocks but no types → they are on types. Types but no rooms
  // → they are on rooms. Close the browser, come back next week, land on the
  // same step, with no progress record to go stale or disagree with the data.
  //
  // Exactly two things cannot be derived, and both are here:
  //
  //   shapeSkipped  "one building, one floor" leaves NO blocks, which is
  //                 indistinguishable from never having done the step. Without
  //                 this the wizard would send that owner back to step one
  //                 forever.
  //   completedAt   "never appears again once built" survives an owner who
  //                 later deletes every room. Rooms existing is enough to hide
  //                 the wizard; this is what stops it RETURNING.
  //
  // dismissedAt is not a third state, it is a courtesy: the wizard stops
  // interrupting, and the empty Rooms page still offers it.
  roomSetup: {
    shapeSkipped: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },
  },

  // ══ WHERE A ROOM IS — THE PROPERTY'S SHAPE ═══════════════════════════════
  // A room knew its name and its type but not its LOCATION, so 21 rooms could
  // only ever render as 21 identical rows. Every real PMS lays a property out
  // floor-wise; nobody scans a flat list.
  //
  // ── BOTH LEVELS ARE OPTIONAL, AND NEITHER IS A SPECIAL CASE ──────────────
  // A resort of cottages has no blocks. A single building may have blocks with
  // no floors. The naive representation — null-check both everywhere — puts a
  // branch in every consumer, and the branch that gets forgotten is the bug.
  //
  // So STORAGE is honestly sparse (a venue with no blocks stores no blocks),
  // and READING always goes through utils/venueRoomLayout.resolveLayout, which
  // returns the SAME three-level shape every time: blocks → floors → rooms. A
  // venue with no blocks resolves to one unnamed implicit block holding one
  // unnamed implicit floor holding every room. Consumers loop; they never ask
  // "does this venue have blocks".
  //
  // ── ORDER IS THE ARRAY, AND THE ARRAY IS THE OWNER'S ─────────────────────
  // "Ground" sorts after "First" alphabetically, and after "1" numerically, and
  // a venue whose floors are "G", "M", "1", "2" defeats every clever rule. So
  // there is no rule: position in this array IS the order, and reordering
  // rewrites the array. No `order` integer, because two sources for one fact
  // is one that can drift.
  //
  // Names are stored EXACTLY as typed — "Ground", "G", "0", "Garden Block" —
  // never normalised, never inferred, never title-cased.
  blocks: [{
    name: { type: String, required: true, maxlength: 120 },
    /**
     * ── RETIRED, AS THE STEP BEFORE DELETED ────────────────────────────────
     * Deleting a block cannot be undone, so it is not one click away: a block
     * is deactivated first and deleted from there. Absent means active, which
     * is every block that already exists — no migration, no backfill.
     *
     * ── IT IS ORGANISATIONAL ONLY ──────────────────────────────────────────
     * This does NOT take the rooms inside out of service. A block is where a
     * room IS, not whether it can be sold, and quietly emptying a property's
     * inventory because somebody tidied the layout would be a far worse bug
     * than the one the two-step prevents. Availability reads
     * Venue.rooms[].isActive and never consults this — see
     * utils/venueRoomNights.activeRooms — and resolveLayout keeps rendering a
     * deactivated block's rooms so none of them can fall off the screen.
     */
    isActive: { type: Boolean, default: true },
    /**
     * Floors within this block, in the owner's order. An empty array is a
     * block that holds rooms directly, which resolveLayout renders as one
     * unnamed floor rather than as an absence.
     */
    floors: [{
      name: { type: String, required: true, maxlength: 120 },
      /** Same two-step, same organisational-only meaning, as the block above. */
      isActive: { type: Boolean, default: true },
    }],
  }],

  // Phase 5 (PMS) — the operational rooms inventory used for guest allotment
  // and check-in/out.
  rooms: [{
    name: { type: String, required: true }, // name or number, e.g. "Suite 2"
    /**
     * The type this room belongs to. Rooms created before types existed have
     * none and read as one-offs — `type` below still describes those.
     */
    typeRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    // The legacy free-standing classification. Kept because allotment and
    // check-in read it today, and pre-typeRef rooms have nothing else.
    type: { type: String, enum: ["standard", "deluxe", "suite", "dorm", "other"], default: "standard" },
    capacity: { type: Number, default: 2 },
    notes: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    /**
     * ── WHAT THIS ROOM HAS DIVERGED ON ─────────────────────────────────────
     * Editing a type updates every room of that type EXCEPT the fields the room
     * has overridden. This records WHICH fields those are, by name, so the rule
     * is data rather than a guess at whether a value "looks custom".
     *
     * Without it, inheritance has to infer intent from whether a room's value
     * differs from its type — which cannot tell "deliberately 3" from "was 3
     * when the type said 3, and the type has since changed".
     */
    overrides: [{ type: String }],
    /** Set only when overridden; otherwise the type's amenities apply. */
    amenities: [{ type: String }],
    /** Set only when overridden; otherwise the type's rate applies. */
    rate: { type: Number, default: null },
    /**
     * ── WHERE THIS ROOM IS ─────────────────────────────────────────────────
     * Both null on every room that existed before this build, and on every room
     * at a venue that has no blocks. Null is not an error state: it means "this
     * venue has no structure to place it in" when there are no blocks, and
     * "not placed yet" when there are. resolveLayout tells those two apart so
     * no screen has to.
     *
     * floorRef without blockRef is meaningless and is refused at the
     * controller: a floor only exists inside a block.
     */
    /**
     * ── TEMPORARILY UNUSABLE, WITH A REASON AND A DATE RANGE ──────────────
     * A broken air-conditioner is not a reason to DEACTIVATE a room:
     * deactivation is permanent and removes it from the property, and an owner
     * who reaches for it to cover a week of repairs has quietly shrunk their
     * inventory forever. This is the temporary, dated, reversible answer, and
     * it expires by itself.
     *
     * [from, to) — inclusive of `from`, exclusive of `to`, matching how nights
     * are stored and how every window in this codebase is compared. Out from
     * the 10th to the 12th means unusable on the 10th and 11th, and sellable
     * again on the 12th.
     *
     * Unlike isActive this is DATED, so availability cannot filter on it
     * without knowing which nights are in question — see utils/venueOutOfOrder.
     *
     * No defaults: absent means in order, which is every room today.
     */
    outOfOrder: {
      /** Required when set — "out of order" with no reason is unanswerable. */
      reason: { type: String },
      from: { type: Date },
      to: { type: Date },
      at: { type: Date },
      byName: { type: String },
    },

    /**
     * ── IS THIS ROOM READY ────────────────────────────────────────────────
     * A SECOND AXIS, never folded into free/occupied/held: a room can be
     * occupied and dirty, or free and dirty, and collapsing the two would make
     * "dirty" erase "held".
     *
     * NO DEFAULTS. A room nobody has assessed is untracked — not clean, not
     * dirty — and shows no badge. That is what makes this a no-op for every
     * room that already exists, and it is the same reason roomsPolicy writes
     * nothing until an owner answers.
     *
     * Nothing is inferred from the check-out checklist: it is free text, and a
     * room with every item ticked still needs servicing.
     *
     * NOT venue.amenities.housekeeping, which is a marketing boolean meaning
     * "this venue offers a housekeeping service". Same word, different scope,
     * different question.
     */
    housekeeping: {
      status: { type: String, enum: ["clean", "dirty", "inspected"] },
      at: { type: Date },
      byName: { type: String },
    },
    blockRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    floorRef: { type: mongoose.Schema.Types.ObjectId, default: null },
  }],
  pricing: {
    currency: { type: String, default: "INR" },
    minimumDuration: { type: Number, default: 12 },
    tiers: [{ hours: Number, price: Number }],
    perPlate: { veg: { type: Number, default: 0 }, nonVeg: { type: Number, default: 0 } },
    securityDeposit: { type: Number, default: 0 },
    advancePercent: { type: Number, default: 30 },
    peakSeasonMarkup: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  cateringPolicy: {
    type: { type: String, enum: ["in_house_only", "outside_allowed", "both", "unknown"], default: "unknown" },
    outsideKitchenFee: { type: Number, default: 0 },
    outsideSetupFrom: { type: String, default: "" },
    dietaryOptions: [String],
    cuisines: [String],
    minPerPlate: { type: Number, default: 0 },
  },
  decorPolicy: {
    outsideAllowed: { type: Boolean, default: true },
    inHouseAvailable: { type: Boolean, default: false },
    setupAccessFrom: { type: String, default: "" },
    restrictions: { type: String, default: "" },
  },
  musicPolicy: {
    liveMusicAllowed: { type: Boolean, default: true },
    djAllowed: { type: Boolean, default: true },
    outdoorCurfew: { type: String, default: "11:00 PM" },
    indoorCurfew: { type: String, default: "1:00 AM" },
    inHouseSoundSystem: { type: Boolean, default: false },
  },
  amenities: {
    swimmingPool: { type: Boolean, default: false },
    generatorBackup: { type: Boolean, default: false },
    parking: { type: Boolean, default: false },
    parkingCapacity: { type: Number, default: 0 },
    helipad: { type: Boolean, default: false },
    garden: { type: Boolean, default: false },
    airConditioning: { type: Boolean, default: false },
    cctv: { type: Boolean, default: false },
    wifi: { type: Boolean, default: false },
    elevator: { type: Boolean, default: false },
    bridalSuite: { type: Boolean, default: false },
    kalyanMandap: { type: Boolean },
    floatingMandap: { type: Boolean },
    groomRoom: { type: Boolean, default: false },
    makeupRoom: { type: Boolean, default: false },
    changingRooms: { type: Boolean, default: false },
    prayerRoom: { type: Boolean, default: false },
    fireNOC: { type: Boolean, default: false },
    liquorLicense: { type: Boolean, default: false },
    dayOfCoordinator: { type: Boolean, default: false },
    securityStaff: { type: Boolean, default: false },
    // MARKETING: "this venue offers housekeeping". NOT rooms[].housekeeping,
    // which is the operational clean/dirty/inspected state of one room.
    housekeeping: { type: Boolean, default: false },
    valetParking: { type: Boolean, default: false },
    shuttleService: { type: Boolean, default: false },
    petFriendly: { type: Boolean, default: false },
    smokingAllowed: { type: Boolean, default: false },
    evCharging: { type: Boolean, default: false },
    outsideAlcohol: { type: String, enum: ["yes", "no", "extra_charge"], default: "no" },
  },
  photos: {
    venue: [String],
    decor: [String],
    rooms: [String],
    spaces: [String],
  },
  // A raw Google Places Photo endpoint URL is NOT a durable image: it carries an
  // embedded API key and dies the moment that key is rotated or revoked. That is
  // exactly what happened to 46 published venues (repaired by
  // scripts/repair-places-coverphotos.js). The endpoint is a redirector — always
  // follow its 302 and persist the final lh3.googleusercontent.com URL instead.
  // See RAW_PLACES_PHOTO_RE / assertDurableCoverPhoto below.
  coverPhoto: {
    type: String,
    default: "",
    validate: {
      validator: isDurableCoverPhoto,
      message: (p) =>
        `coverPhoto must not be a raw Google Places Photo URL with an embedded key ` +
        `(got "${String(p.value).slice(0, 80)}…"). Resolve the 302 and store the ` +
        `final lh3.googleusercontent.com URL instead.`,
    },
  },
  featurePhoto: { type: String, default: "" },
  // Venue brand logo (URL from the /file/upload flow, or a data: URI). Rendered
  // top-left on quote/invoice PDFs when set; absence degrades gracefully.
  logo: { type: String, default: "" },
  policies: {
    cancellation: { type: String, default: "" },
    refund: { type: String, default: "" },
    otherRestrictions: { type: String, default: "" },
  },
  // Structured policy clauses (Phase: owner-feedback). Three ordered lists of
  // numbered clause strings. Legacy `policies` (above) is NEVER dropped — it is
  // migrated into policyDoc on read (see controllers/venue.js withPolicyDoc) so
  // nothing is lost. New field name (couldn't overload the `policies` object).
  policyDoc: {
    policies: [{ type: String }],
    terms: [{ type: String }],
    refund: [{ type: String }],
  },
  /**
   * THE VENUE'S TERMS, AS A FILE.
   *
   * Owners already have their T&Cs — as a Google Doc, exported to PDF — and
   * they are not going to retype them as clauses in our editor. The audit that
   * prompted this found why it mattered: `policyDoc` has no write path
   * anywhere, and the doc-template routes are never called by the portal, so
   * "Send terms & conditions" refused with a message pointing at two places an
   * owner could not reach.
   *
   * ONE DOCUMENT PER VENUE, not per lead. Venues do not rewrite their terms
   * per couple, and a per-lead copy would invite exactly the drift that makes
   * "which terms did they get?" unanswerable.
   *
   * The FILE lives on S3 via the existing /file/upload path; this holds only
   * the pointer and the provenance an owner needs to recognise it.
   */
  termsDocument: {
    url: { type: String, default: "" },
    filename: { type: String, default: "" },
    sizeBytes: { type: Number },
    contentType: { type: String, default: "" },
    uploadedAt: { type: Date },
    // Who to ask about it. Stored as a NAME as well as an id because the id
    // stops resolving the day that member leaves, and "uploaded by someone who
    // no longer works here" is still useful provenance.
    uploadedBy: { type: mongoose.Schema.Types.ObjectId },
    uploadedByName: { type: String, default: "" },
  },

  // ── S1b VENUE BRIEF ────────────────────────────────────────────────────────
  // Deliberately the SAME shape as termsDocument above, because it is the same
  // kind of thing: one venue-level PDF the owner uploaded and approved, sent
  // AS-IS. Never converted, and unlike the T&Cs never stitched behind a cover —
  // a brief is the venue describing itself, so there is nothing to personalise.
  // The file goes up through the existing /file/upload → S3 path; this holds the
  // pointer and the provenance.
  briefDocument: {
    url: { type: String, default: "" },
    filename: { type: String, default: "" },
    sizeBytes: { type: Number },
    contentType: { type: String, default: "" },
    uploadedAt: { type: Date },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId },
    uploadedByName: { type: String, default: "" },
  },

  // ── S1c CANCELLATION POLICY ────────────────────────────────────────────────
  // Rich text, stored as a CONSTRAINED BLOCK TREE rather than HTML.
  //
  // The editor (TipTap) hands us a ProseMirror document, which is already
  // structured JSON. Storing that structure — instead of the HTML it could be
  // serialised to — is what makes the PDF renderer tractable: it walks a typed
  // tree of four node kinds with one inline mark, so there is no HTML to parse
  // and no sanitiser to trust. Anything outside this schema is rejected at the
  // controller rather than stored and rendered later.
  //
  // Four block kinds and one mark, matching exactly what the brief asks for:
  // headings, bold, ordered and unordered lists. No merge fields, no import,
  // no tables, no images, no links — the T&C editor we deferred is where those
  // belong, and every one of them is a fidelity risk on a document that
  // decides refunds.
  cancellationPolicy: {
    blocks: [
      {
        _id: false,
        // "heading" | "paragraph" | "bulletList" | "orderedList"
        type: { type: String, enum: ["heading", "paragraph", "bulletList", "orderedList"], required: true },
        // 1..3, heading only. Deeper than 3 is not a policy, it is an outline.
        level: { type: Number, min: 1, max: 3 },
        // Inline runs. A block is a sequence of {text, bold} spans, which is the
        // smallest thing that can express "bold this phrase" without inviting
        // arbitrary markup.
        spans: [{ _id: false, text: { type: String, default: "" }, bold: { type: Boolean, default: false } }],
        // List items, each itself a span sequence. One level deep on purpose.
        items: [{ _id: false, spans: [{ _id: false, text: { type: String, default: "" }, bold: { type: Boolean, default: false } }] }],
      },
    ],
    updatedAt: { type: Date },
    updatedBy: { type: mongoose.Schema.Types.ObjectId },
    updatedByName: { type: String, default: "" },
  },

  contact: {
    primaryName: { type: String, default: "" },
    primaryPhone: { type: String, default: "" },
    secondaryPhone: { type: String, default: "" },
    email: { type: String, default: "" },
    website: { type: String, default: "" },
    bestTimeToReach: { type: String, default: "anytime" },
    languages: [String],
    whatsappPhone: { type: String },
    whatsappSameAsPrimary: { type: Boolean, default: false },
    phones: [{ number: { type: String }, name: { type: String } }],
  },
  blockedDates: [String],
  // D3 (additive) venue-tunable operational settings.
  settings: {
    // How long an approved/requested hold lives before the expiry sweep frees
    // it. Owner-configurable; 5 days is the marketplace default.
    holdExpiryDays: { type: Number, default: 5, min: 1, max: 60 },
    // E3x: default for the per-document whiteLabel flag on new quotes/bills/
    // invoices. false keeps the co-branded render (system line + footer).
    documentsWhiteLabelDefault: { type: Boolean, default: false },
    // MB-CRM S0d: when true, a lead arriving with NO explicit assignee is
    // round-robined across active Sales members. Explicit assignment always
    // wins; off by default so nothing changes for venues that don't opt in.
    autoAssignLeads: { type: Boolean, default: false },
    // BUILD B: pricing advice on the Money tab. ON by default because the
    // whole point is to turn "quote strong" into a number, but an owner who
    // prices from experience and finds it noise can switch it off venue-wide
    // rather than dismissing it lead by lead forever.
    pricingAdvice: { type: Boolean, default: true },

    // ── S1d PAYMENT SLAB DEFAULTS ────────────────────────────────────────────
    // The venue's preferred schedule shapes. These PRE-POPULATE the Confirm
    // Booking wizard and are always overridable there — they are a starting
    // point, never a constraint, and nothing here is ever copied onto a lead.
    //
    // Percentages, not amounts, because a shape is reusable across bookings of
    // any value; the wizard computes the money from the booking total. Each
    // slab's percentages must total 100, enforced at the controller.
    //
    // offsetDays is relative to the EVENT date and negative means before it, so
    // -30 reads as "thirty days before the event". null means "on booking",
    // which is how a token or an up-front instalment is expressed without
    // inventing a second concept.
    paymentSlabs: [
      {
        _id: false,
        name: { type: String, default: "" },
        isDefault: { type: Boolean, default: false },
        rows: [
          {
            _id: false,
            label: { type: String, default: "" },
            percent: { type: Number, default: 0, min: 0, max: 100 },
            offsetDays: { type: Number, default: null },
          },
        ],
      },
    ],
  },
  // backward compat
  phone: { type: String, default: "" },
  email: { type: String, default: "" },
  website: { type: String, default: "" },
  googlePlaceId: { type: String, default: "" },
  googleRating: { type: Number, default: null },
  googleReviewCount: { type: Number, default: null },
  scrapedFrom: [String],
  seoKeywords: [String],
  dataCompleteness: { type: Number, default: 1 },
  featured: { type: Boolean, default: false },
  // PUBLICATION LIFECYCLE ONLY (MB-OSV S0). This field used to answer two
  // unrelated questions — "is the listing publishable?" and "has Wedsy verified
  // this venue?" — which made verified-but-draft unrepresentable and coupled
  // revoking verification to demoting the listing. Verification now lives in
  // `verified` below; partnership lives in `partner`.
  //
  // "verified" / "pending_outreach" / "outreach_sent" are LEGACY conflated
  // values, retained so existing documents keep validating. New writes must
  // NEVER set status = "verified" — set verified.isVerified instead.
  // scripts/backfill-venue-tracks.js migrates the legacy value forward.
  status: { type: String, enum: ["draft", "published", "pending_outreach", "outreach_sent", "verified", "rejected"], default: "draft" },

  // ── TRACK A (data) — ours alone, no venue involvement ──────────────────────
  // Terminal state of the enrichment track. Setting it is an OS call and says
  // nothing about whether the venue is a commercial partner.
  verified: {
    // NO default, deliberately. Mongoose applies defaults to missing paths when
    // it hydrates a document, so `default: false` would hand back a hard false
    // for every pre-S0 venue and silently defeat the legacy
    // status === "verified" fallback in utils/venueTracks.verifiedBadge.
    // Undefined means "never answered"; the fallback reads the old field.
    // After scripts/backfill-venue-tracks.js every document holds a real
    // boolean and the fallback stops being reachable.
    isVerified: { type: Boolean },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    verifiedAt: { type: Date },
    notes: { type: String, default: "", maxlength: 2000 },
  },
  // Track A progression. The raw → enriching → enriched stage is DERIVED from
  // these fields (utils/venueTracks.enrichmentStage), never stored.
  //
  // Distinct from the legacy `dataCompleteness` above: that is the listing's
  // auto-computed fill rate, this is the OS team's curated score over the
  // fields that actually matter to a couple. Both are kept; neither overwrites
  // the other.
  enrichment: {
    completeness: { type: Number, default: 0, min: 0, max: 100 },
    missingFields: [{ type: String }],
    lastEnrichedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    lastEnrichedAt: { type: Date },
  },
  // How this venue entered the directory. Drives the directory entry-point
  // facet; "" is the not-yet-classified sentinel for pre-S0 rows.
  entryPoint: { type: String, enum: ["scraped", "claimed", "walk_up", ""], default: "" },

  // ── TRACK B (partnership) — the commercial relationship ────────────────────
  // Independent of Track A in both directions: a venue may be verified and
  // never approached, or a signed partner nobody has data-checked.
  partner: {
    accessGrantedAt: { type: Date },
    accessGrantedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    // Which door the venue came through. Both triggers run the SAME
    // grant-access action — this only records provenance.
    accessGrantTrigger: { type: String, enum: ["claim_approval", "wedsy_select"] },
    // DESIGNATED at grant time, never inferred from venue.contact — the person
    // who actually holds the login may not be the number on the listing.
    primaryPhone: { type: String, default: "" },
    primaryEmail: { type: String, default: "" },
    // Stamped by the EXISTING owner-auth funnel (controllers/venueOwner.js
    // loginAsIdentity) on the first successful sign-in. Half of the partner
    // badge conjunction — see utils/venueTracks.partnerBadge.
    firstOwnerLoginAt: { type: Date },
    terms: {
      // Wedsy's default commercial posture: no strings. A venue is a partner
      // without owing anything until someone deliberately says otherwise.
      unconditional: { type: Boolean, default: true },
      commissionPercent: { type: Number, default: null, min: 0, max: 100 },
      inHousePlanner: { type: Boolean, default: false },
      decorRights: { type: Boolean, default: false },
    },
    onboarding: {
      status: { type: String, enum: ["not_started", "in_progress", "complete"], default: "not_started" },
      stages: [{
        key: { type: String, required: true },
        label: { type: String, default: "" },
        done: { type: Boolean, default: false },
        completedAt: { type: Date },
        completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
        notes: { type: String, default: "", maxlength: 2000 },
      }],
      // Scan-upload only — no e-sign. Uses the existing /file/upload path.
      agreementDocUrl: { type: String, default: "" },
      ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
    },
  },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
  // Phase 3 (3.3) invoicing profile — venue-owned, editable from listing/settings.
  gstin: { type: String, default: "" },
  pan: { type: String, default: "" },
  invoicePrefix: { type: String, default: "" },
  enquiries: [{ type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" }],
  nearbyAccommodation: [{
    placeId: { type: String },
    name: { type: String },
    rating: { type: Number },
    vicinity: { type: String },
    priceLevel: { type: Number },
    photoReference: { type: String },
    distanceKm: { type: Number },
  }],
  nearbyAccommodationRefreshedAt: { type: Date },
  googleReviews: [{
    authorName: { type: String },
    rating: { type: Number },
    text: { type: String },
    time: { type: Number },
    profilePhotoUrl: { type: String },
  }],
  googleReviewsRefreshedAt: { type: Date },
  // Phase 4.3 — cached competitor-insights payload (24h TTL). Anonymized
  // zone-cohort aggregates only; never any per-competitor data. Recomputed on
  // read when stale (see controllers/venueCompetitive.js).
  competitiveCache: {
    computedAt: { type: Date },
    payload: { type: mongoose.Schema.Types.Mixed },
  },
}, { timestamps: true });

// Path validators only fire on document save()/create() — Mongoose skips them on
// update queries unless the caller opts in with runValidators. The failure this
// guard exists to prevent came from an ad-hoc script calling updateOne directly,
// so the same rule is enforced at the query layer, where no opt-in is needed.
// Only payloads that actually carry coverPhoto are inspected; every other update
// passes through untouched.
function guardCoverPhotoUpdate(next) {
  const update = this.getUpdate();
  if (!update) return next();
  for (const container of [update, update.$set, update.$setOnInsert]) {
    if (!container || typeof container !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(container, "coverPhoto")) continue;
    if (!isDurableCoverPhoto(container.coverPhoto)) {
      return next(
        new Error(
          `Venue.coverPhoto: refusing to persist a raw Google Places Photo URL with an ` +
            `embedded API key — it breaks when the key rotates. Follow the endpoint's 302 ` +
            `and store the final lh3.googleusercontent.com URL instead. ` +
            `(got "${String(container.coverPhoto).slice(0, 80)}…")`
        )
      );
    }
  }
  return next();
}

VenueSchema.pre("updateOne", guardCoverPhotoUpdate);
VenueSchema.pre("updateMany", guardCoverPhotoUpdate);
VenueSchema.pre("findOneAndUpdate", guardCoverPhotoUpdate);
VenueSchema.pre("replaceOne", guardCoverPhotoUpdate);

VenueSchema.index({ location: "2dsphere" }, { sparse: true });
VenueSchema.index({ slug: 1 });
VenueSchema.index({ status: 1 });
VenueSchema.index({ city: 1, venueType: 1 });
// MB-OSV S0 — the two tracks are filtered independently in the OS directory,
// so each gets its own index rather than a compound one across both.
VenueSchema.index({ "verified.isVerified": 1 });
VenueSchema.index({ "partner.accessGrantedAt": 1 });
VenueSchema.index({ "partner.firstOwnerLoginAt": 1 });
VenueSchema.index({ "partner.onboarding.status": 1 });
VenueSchema.index({ entryPoint: 1 });

const VenueModel = mongoose.model("Venue", VenueSchema);

// MB-OSV S0 — derived two-track badges. Exposed as statics so every read path
// (admin directory, Venue-360, the couple-facing wedsy.in read) computes them
// from ONE implementation. Never stored on the document: a denormalised copy
// is a second source of truth that silently rots.
VenueModel.verifiedBadge = venueTracks.verifiedBadge;
VenueModel.partnerBadge = venueTracks.partnerBadge;
VenueModel.enrichmentStage = venueTracks.enrichmentStage;
VenueModel.partnerStage = venueTracks.partnerStage;
VenueModel.trackSummary = venueTracks.trackSummary;

// Exposed so scripts/verify-coverphoto-guard.js can exercise the coverPhoto
// guard — both the predicate and the exact function registered as the update
// hook — without a database connection. Not part of the runtime API.
VenueModel.isDurableCoverPhoto = isDurableCoverPhoto;
VenueModel.__guardCoverPhotoUpdate = guardCoverPhotoUpdate;

module.exports = VenueModel;

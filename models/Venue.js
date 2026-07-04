const mongoose = require("mongoose");

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
  }],
  accommodation: {
    available: { type: Boolean, default: false },
    totalCapacity: { type: Number, default: 0 },
    roomTypes: [{
      name: String,
      count: { type: Number, default: 0 },
      occupancyPerRoom: { type: Number, default: 2 },
      maxPeoplePerRoom: { type: Number, default: 2 },
      pricePerNight: { type: Number, default: 0 },
      isAC: { type: Boolean, default: true },
      description: { type: String, default: "" },
      photos: [String],
    }],
  },
  // Phase 5 (PMS) — the operational rooms inventory used for guest allotment
  // and check-in/out. Distinct from accommodation.roomTypes (marketing copy);
  // both render side by side on the listing surface.
  rooms: [{
    name: { type: String, required: true }, // name or number, e.g. "Suite 2"
    type: { type: String, enum: ["standard", "deluxe", "suite", "dorm", "other"], default: "standard" },
    capacity: { type: Number, default: 2 },
    notes: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
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
  coverPhoto: { type: String, default: "" },
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
  status: { type: String, enum: ["draft", "published", "pending_outreach", "outreach_sent", "verified", "rejected"], default: "draft" },
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
}, { timestamps: true });

VenueSchema.index({ location: "2dsphere" }, { sparse: true });
VenueSchema.index({ slug: 1 });
VenueSchema.index({ status: 1 });
VenueSchema.index({ city: 1, venueType: 1 });

module.exports = mongoose.model("Venue", VenueSchema);

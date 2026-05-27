// Reusable Google Places enrichment for a single venue.
//
// Three layers, applied in order:
//   1. If venue.googlePlaceId exists → Place Details
//   2. Else → Find Place from Text (name + " Bangalore") → Place Details
//   3. Else → parse address against LOCALITY_MAP for zone/locality
//
// Persists with Venue.updateOne($set). Always sets `enrichedAt` so the script
// can detect already-processed rows on later runs.
//
// Safe to call fire-and-forget — every external call is wrapped, internal
// errors propagate out for the caller to log.

const axios = require("axios");
const Venue = require("../models/Venue");

const KEY = process.env.GOOGLE_PLACES_API_KEY;

// Address-substring → { zone, locality }. Match is longest-key-first so
// "magadi road" beats "magadi" when both are present.
const LOCALITY_MAP = {
  yelahanka: { zone: "north", locality: "Yelahanka" },
  devanahalli: { zone: "airport", locality: "Devanahalli" },
  jakkur: { zone: "north", locality: "Jakkur" },
  hebbal: { zone: "north", locality: "Hebbal" },
  thanisandra: { zone: "north", locality: "Thanisandra" },
  kogilu: { zone: "north", locality: "Kogilu" },
  bagalur: { zone: "airport", locality: "Bagalur" },
  whitefield: { zone: "east", locality: "Whitefield" },
  marathahalli: { zone: "east", locality: "Marathahalli" },
  sarjapur: { zone: "east", locality: "Sarjapur" },
  varthur: { zone: "east", locality: "Varthur" },
  bannerghatta: { zone: "south", locality: "Bannerghatta" },
  "electronic city": { zone: "south", locality: "Electronic City" },
  kanakapura: { zone: "south", locality: "Kanakapura" },
  jigani: { zone: "south", locality: "Jigani" },
  anekal: { zone: "south", locality: "Anekal" },
  "magadi road": { zone: "west", locality: "Magadi Road" },
  tumkur: { zone: "west", locality: "Tumkur" },
  rajajinagar: { zone: "west", locality: "Rajajinagar" },
  yeshwanthpur: { zone: "west", locality: "Yeshwanthpur" },
  "jp nagar": { zone: "central", locality: "JP Nagar" },
  koramangala: { zone: "central", locality: "Koramangala" },
  indiranagar: { zone: "central", locality: "Indiranagar" },
  "hsr layout": { zone: "central", locality: "HSR Layout" },
};

// Coordinate → zone bucket. Order matters: airport sits north of the "north"
// band so far-north Devanahalli venues land in airport.
function zoneFromCoords(lng, lat) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (lat > 13.08) return "airport";
  if (lat > 13.02 && lat <= 13.08) return "north";
  if (lng > 77.70) return "east";
  if (lat < 12.87) return "south";
  if (lng < 77.50) return "west";
  return "central";
}

function localityFromAddress(address) {
  if (!address) return null;
  const lower = String(address).toLowerCase();
  const keys = Object.keys(LOCALITY_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lower.includes(k)) return LOCALITY_MAP[k];
  }
  return null;
}

function extractLocality(addressComponents) {
  if (!Array.isArray(addressComponents)) return "";
  const findByType = (t) => addressComponents.find((c) => Array.isArray(c.types) && c.types.includes(t));
  const c =
    findByType("sublocality_level_1") ||
    findByType("sublocality") ||
    findByType("administrative_area_level_3");
  return c?.long_name || "";
}

async function fetchDetails(placeId) {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
    `&fields=geometry,address_components,photos,formatted_phone_number,website,rating,user_ratings_total` +
    `&key=${KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data.status !== "OK") return null;
  return data.result;
}

async function findPlace(name) {
  const q = encodeURIComponent(`${name} Bangalore`);
  const url =
    `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}` +
    `&inputtype=textquery&fields=place_id,geometry,name&key=${KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data.status !== "OK" || !Array.isArray(data.candidates) || data.candidates.length === 0) return null;
  return data.candidates[0];
}

// The Places Photo endpoint returns a 302 redirect to the actual image on
// googleusercontent.com. We want the FINAL URL, not the image bytes, so we
// disable redirect-following and read the Location header. axios throws on
// 3xx when maxRedirects=0; that's the success path here.
async function resolvePhotoUrl(photoReference) {
  const url =
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800` +
    `&photo_reference=${encodeURIComponent(photoReference)}&key=${KEY}`;
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      timeout: 15000,
    });
    return res.headers?.location || null;
  } catch (err) {
    if (err.response && err.response.status >= 300 && err.response.status < 400) {
      return err.response.headers?.location || null;
    }
    return null;
  }
}

/**
 * Enrich a single venue. Pass either the venue document, a plain object with
 * _id, or just the _id string. Resolves to { _id, slug, set } where `set` is
 * the actual $set payload that was written (useful for caller reporting).
 */
async function enrichVenue(venueOrId) {
  if (!KEY) {
    return { skipped: "GOOGLE_PLACES_API_KEY not set" };
  }
  const _id = (venueOrId && venueOrId._id) || venueOrId;
  if (!_id) throw new Error("enrichVenue: missing venue id");

  const venue = await Venue.findById(_id).lean();
  if (!venue) throw new Error(`enrichVenue: venue ${_id} not found`);

  const update = {};
  let placeId = venue.googlePlaceId;
  let details = null;

  // Layer 2 — discover place_id by name if missing
  if (!placeId && venue.name) {
    try {
      const found = await findPlace(venue.name);
      if (found?.place_id) {
        placeId = found.place_id;
        update.googlePlaceId = placeId;
      }
    } catch (_) {
      // continue without place_id
    }
  }

  // Layer 1 — pull details
  if (placeId) {
    try {
      details = await fetchDetails(placeId);
    } catch (_) {
      // continue with details=null
    }
  }

  if (details) {
    const loc = details.geometry?.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
      update.location = { type: "Point", coordinates: [loc.lng, loc.lat] };
    }
    const locality = extractLocality(details.address_components);
    if (locality) update.locality = locality;
    if (details.formatted_phone_number && !venue.phone) {
      update.phone = details.formatted_phone_number;
    }
    if (details.website && !venue.website) {
      update.website = details.website;
    }
    if (typeof details.rating === "number") update.googleRating = details.rating;
    if (typeof details.user_ratings_total === "number") {
      update.googleReviewCount = details.user_ratings_total;
    }

    // Photos — resolve up to 10 photo_references to final URLs
    if (Array.isArray(details.photos) && details.photos.length > 0) {
      const refs = details.photos.slice(0, 10).map((p) => p && p.photo_reference).filter(Boolean);
      const urls = [];
      for (const ref of refs) {
        const u = await resolvePhotoUrl(ref);
        if (u) urls.push(u);
      }
      if (urls.length > 0) update.googlePhotos = urls;
    }
  }

  // Layer 3 — locality + zone fallback from address keywords
  if (!update.locality && venue.address) {
    const fallback = localityFromAddress(venue.address);
    if (fallback) {
      update.locality = fallback.locality;
      if (!update.zone) update.zone = fallback.zone;
    }
  }

  // Real coordinates win over the address-keyword zone fallback above
  const coords = update.location?.coordinates || venue.location?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) {
    const z = zoneFromCoords(coords[0], coords[1]);
    if (z) update.zone = z;
  }

  update.enrichedAt = new Date();

  await Venue.updateOne({ _id }, { $set: update });
  return { _id, slug: venue.slug, set: update };
}

module.exports = enrichVenue;
module.exports.zoneFromCoords = zoneFromCoords;
module.exports.localityFromAddress = localityFromAddress;
module.exports.LOCALITY_MAP = LOCALITY_MAP;

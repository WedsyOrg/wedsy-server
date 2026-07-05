// Reusable Google Places enrichment for a single venue.
//
// Three layers, applied in order:
//   1. If venue.googlePlaceId exists → Place Details
//   2. Else → Find Place from Text (name + " Bangalore") → Place Details
//   3. Else → parse locality + address against ZONE_MAP for zone
//
// Persists with Venue.updateOne($set). Always sets `enrichedAt` so the script
// can detect already-processed rows on later runs.
//
// Safe to call fire-and-forget — every external call is wrapped, internal
// errors propagate out for the caller to log.

const axios = require("axios");
const Venue = require("../models/Venue");

const KEY = process.env.GOOGLE_PLACES_API_KEY;

// Comprehensive Bangalore zone → area-list map. Match is zone-order-first
// (airport → north → east → south → west → central) so the most specific /
// peripheral zones win when an address mentions multiple substrings.
const ZONE_MAP = {
  airport: [
    "devanahalli", "bagalur", "budigere", "doddaballapur", "nandi hills",
    "kempegowda international", "kial", "sonnenahalli", "chikkajala",
    "kannurhobli", "sadahalli", "sulibele",
  ],
  north: [
    "yelahanka", "jakkur", "hebbal", "thanisandra", "kogilu",
    "sahakara nagar", "sahakar nagar", "jalahalli", "ms palya",
    "vidyaranyapura", "kalyan nagar", "rt nagar", "hennur",
    "nagawara", "kothanur", "byrathi", "amruthahalli", "anandnagar",
    "attur", "byatarayanapura", "chagalatti", "chikkabettahalli",
    "dollar colony", "geddalahalli", "hesaraghatta", "hmt layout",
    "kannur", "kodigehalli", "mathikere", "ms ramaiah",
    "manyata tech park", "new bel road", "palace orchards",
    "puttenahalli north", "sanjay nagar", "sanjaynagar",
    "chikkabanavara", "gokula", "soladevanahalli",
    "air force", "yelahanka new town", "lingarajapuram",
    "bsf camp", "kogilu main road", "doddaballapur road",
  ],
  east: [
    "whitefield", "marathahalli", "marthahalli", "varthur", "brookefield",
    "kadugodi", "mahadevapura", "bellandur", "carmelaram", "haralur",
    "harlur", "dommasandra", "panathur", "kadubeesanahalli", "thubarahalli",
    "kundalahalli", "ramagondanahalli", "soukya road", "virgonagar",
    "hoodi", "itpl", "hope farm", "doddanekundi", "medahalli",
    "garudacharpalya", "krishnarajapuram", "kr puram", "k r puram",
    "benniganahalli", "tin factory", "old madras road",
    "indiranagar", "domlur", "hal airport road",
    "hal 2nd stage", "hal 3rd stage", "hal layout",
    "cambridge layout", "ulsoor", "babusapalaya", "nagondanahalli",
    "gunjur", "ambalipura", "sarjapur road", "sarjapur",
    "hagadur", "immadihalli", "nallurhalli",
    "banaswadi", "horamavu", "hormavu",
    "ramamurthy nagar", "kammanahalli", "bhattarahalli",
    "hoysalanagar", "ithangur", "hosa road",
    "aecs layout east", "electronic city phase 2 east",
  ],
  south: [
    "bannerghatta", "electronic city", "jigani", "kanakapura", "anekal",
    "begur", "gottigere", "hulimavu", "arekere", "akshayanagar",
    "akshaya nagar", "hongasandra", "uttarahalli", "jp nagar",
    "jayanagar", "btm layout", "hsr layout", "bommanahalli",
    "singasandra", "kudlu", "chandapura", "attibele", "silkboard",
    "konankunte", "konanakunte", "sarakki", "padmanabhanagar",
    "banashankari", "basavanagudi", "hanumanthanagar", "thyagarajanagar",
    "chandra layout", "kengeri", "rajarajeshwari nagar", "mysore road",
    "bidadi", "dollars colony", "puttenahalli south", "subramanyapura",
    "kumaraswamy layout", "girinagar", "katriguppe", "vidyapeeta",
    "ideal homes", "nayandahalli", "hosakerehalli", "pattanagere",
    "mailasandra", "ullal", "talaghattapura", "nice road",
    "hebbagodi", "bommasandra", "marsur road", "chandapura anekal",
    "kodichikkanahalli", "munnekollal", "gattahalli", "choodasandra",
    "parappana agrahara", "koramangala", "bilekahalli",
    "hongasandra south", "begur road", "aecs layout south",
    "haralur road", "harlur road", "jakkasandra", "maruthi nagar",
  ],
  west: [
    "rajajinagar", "vijayanagar", "peenya", "magadi road", "tumkur road",
    "nagarbhavi", "nagarabhavi", "naagarabhaavi", "mahalakshmi layout",
    "prakash nagar", "nandini layout", "laggere", "dasarahalli",
    "t dasarahalli", "bagalgunte", "basaveshwaranagar", "basaveshwara nagar",
    "chord road", "rajgopal nagar", "bhel layout",
    "chikkabanavara west", "kengeri west",
    "rajarajeshwari nagar west", "mysore road west",
    "nagarbhavi west", "vijayanagar west",
    "mahalakshmi layout west", "srirampura west",
    "laggere west", "nandini layout west", "yeshwanthpur",
    "peenya industrial", "jalahalli cross",
  ],
  central: [
    "mg road", "brigade road", "commercial street", "cubbon park",
    "palace grounds", "lavelle road", "richmond road", "cunningham road",
    "sankey road", "infantry road", "museum road", "residency road",
    "church street", "st marks road", "langford road", "millers road",
    "richmond circle", "kasturba road", "raj bhavan", "high court",
    "vidhana soudha", "city market", "majestic", "kempegowda bus stand",
    "city railway station", "gandhinagar bangalore", "chickpet",
    "avenue road", "cottonpet", "balepet", "nagarathpet", "sultanpet",
    "taragupet", "upparpet", "cubbonpet", "mamulpet",
    "malleshwaram", "malleswaram", "sadashivanagar", "seshadripuram",
    "palace guttahalli", "subramanyanagar", "wilson garden",
    "cox town", "cooke town", "fraser town", "frazer town",
    "benson town", "cantonment", "jayamahal", "st johns road",
    "richmond town", "cleveland town", "langford town", "shivajinagar",
    "tasker town", "johnson market", "vasanth nagar",
    "behind ulsoor lake", "ulsoor central", "palace road",
    "raj bhavan road", "shivajinagar central", "infantry road",
    "richmond road", "ulsoor lake", "halasuru",
  ],
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

// Pick a zone for a venue by scanning both its (Google-derived) locality and
// raw address for any of the substring markers in ZONE_MAP. Order matters —
// airport is checked first so Devanahalli wins over "north", then north,
// east, south, west, central. Returns "" when no marker matches.
function localityToZone(locality, address) {
  if (!locality && !address) return "";
  const text = ((locality || "") + " " + (address || "")).toLowerCase();
  const zoneOrder = ["airport", "north", "east", "south", "west", "central"];
  for (const zone of zoneOrder) {
    for (const area of ZONE_MAP[zone]) {
      if (text.includes(area)) return zone;
    }
  }
  return "";
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

  // Layer 3 — zone fallback from locality + address keywords. (Locality
  // itself is no longer derived here — it's already filled in Layer 1 from
  // Google's sublocality. ZONE_MAP only knows zones.)
  if (!update.zone) {
    const z = localityToZone(update.locality || venue.locality, venue.address);
    if (z) update.zone = z;
  }

  // Real coordinates win over the address-keyword zone fallback above
  const coords = update.location?.coordinates || venue.location?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) {
    const z = zoneFromCoords(coords[0], coords[1]);
    if (z) update.zone = z;
  }

  update.enrichedAt = new Date();

  await Venue.updateOne({ _id }, { $set: update });

  // D10: enrichment is a SYSTEM actor on the activity spine — one summary row
  // (field-level noise would drown the owner's trail). Fire-and-forget.
  try {
    const { logActivity } = require("./venueActivity");
    const touched = Object.keys(update).filter((k) => k !== "enrichedAt");
    if (touched.length > 0) {
      logActivity({
        venue: _id,
        actorType: "system",
        actorName: "enrichment",
        action: "venue_enriched",
        entity: "venue",
        field: touched.join(",").slice(0, 500),
        severity: "normal",
      }).catch(() => {});
    }
  } catch (_) { /* activity module absent on older branches */ }

  return { _id, slug: venue.slug, set: update };
}

module.exports = enrichVenue;
module.exports.zoneFromCoords = zoneFromCoords;
module.exports.localityToZone = localityToZone;
module.exports.ZONE_MAP = ZONE_MAP;

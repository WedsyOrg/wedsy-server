// Shared Google Places proxy. The API key is read from the environment only —
// never hardcode it. Uses global fetch (Node 18+), matching controllers/venueNearby.js.

const requireKey = () => {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }
  return key;
};

// Place Autocomplete → [{ placeId, description }]
const autocomplete = async (input, country = "in") => {
  const key = requireKey();
  if (!input) return [];
  try {
    const url =
      "https://maps.googleapis.com/maps/api/place/autocomplete/json" +
      `?input=${encodeURIComponent(input)}` +
      `&components=country:${encodeURIComponent(country)}` +
      `&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return (data.predictions || []).map((p) => ({
      placeId: p.place_id,
      description: p.description,
    }));
  } catch (err) {
    throw new Error(`Places autocomplete failed: ${err.message}`);
  }
};

// Pull a single component's long_name by type from an address_components array.
const componentOf = (components, type) => {
  const match = (components || []).find(
    (c) => Array.isArray(c.types) && c.types.includes(type)
  );
  return match ? match.long_name : undefined;
};

// Place Details → { placeId, formattedAddress, lat, lng, city, state, pincode, country }
const details = async (placeId) => {
  const key = requireKey();
  if (!placeId) {
    throw new Error("placeId is required");
  }
  try {
    const url =
      "https://maps.googleapis.com/maps/api/place/details/json" +
      `?place_id=${encodeURIComponent(placeId)}` +
      "&fields=address_component,geometry,formatted_address,place_id" +
      `&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const result = data.result || {};
    const components = result.address_components || [];
    const loc = result.geometry?.location || {};
    return {
      placeId: result.place_id || placeId,
      formattedAddress: result.formatted_address,
      lat: typeof loc.lat === "number" ? loc.lat : undefined,
      lng: typeof loc.lng === "number" ? loc.lng : undefined,
      city:
        componentOf(components, "locality") ||
        componentOf(components, "postal_town") ||
        componentOf(components, "administrative_area_level_2"),
      // Neighbourhood / area — maps to Venue.locality so the owner form autofills it.
      area:
        componentOf(components, "sublocality_level_1") ||
        componentOf(components, "sublocality") ||
        componentOf(components, "neighborhood"),
      state: componentOf(components, "administrative_area_level_1"),
      pincode: componentOf(components, "postal_code"),
      country: componentOf(components, "country"),
    };
  } catch (err) {
    throw new Error(`Places details failed: ${err.message}`);
  }
};

module.exports = { autocomplete, details };

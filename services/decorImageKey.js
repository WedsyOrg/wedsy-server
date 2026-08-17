// ── Décor image identity — ONE normalisation, shared by every consumer ───────
//
// Lifted verbatim out of services/DecorDraftService.js (2026-08-17) when the
// demo-price read cache needed the same key. It is deliberately in its own
// module rather than imported from DecorDraftService: the cache is consulted BY
// DecorDraftService, so importing the other way would be a require cycle.
//
// If this function changes, EVERY existing cache entry and every existing
// DecorDraft.sourceImage.normalizedUrl silently stops matching. Treat a change
// here as a migration, not an edit.

// NORMALISED image URL: Pinterest serves the same asset at many sizes
// (/236x/, /564x/, /originals/), so the stable identity is the trailing
// hash path (ab/cd/<hash>.jpg), not the full URL.
const normalizeImageUrl = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return s.toLowerCase();
  }
  const host = u.hostname.toLowerCase();
  let path = u.pathname.toLowerCase();
  if (/pinimg\.com$/.test(host)) {
    // drop the size segment: /564x/ab/cd/hash.jpg -> /ab/cd/hash.jpg
    path = path.replace(/^\/(originals|\d+x\d*)\//, "/");
    return `pinimg${path}`;
  }
  return `${host}${path}`;
};

// The cache key for one image. `usable:false` means there is nothing stable to
// key on — a base64-only caller. Per the build ruling we SKIP the cache for
// those rather than inventing a content hash: a content hash lives in a
// different key space, would never collide with the URL key, and would double
// the number of ways the same image can be identified.
const imageKeyFor = ({ imageUrl, pinId } = {}) => {
  const cleanPinId = pinId ? String(pinId).trim() : "";
  const normalizedUrl = normalizeImageUrl(imageUrl);
  return {
    pinId: cleanPinId,
    normalizedUrl,
    usable: !!(cleanPinId || normalizedUrl),
  };
};

module.exports = { normalizeImageUrl, imageKeyFor };

const crypto = require("crypto");
const Venue = require("../models/Venue");
const VenueView = require("../models/VenueView");

// Opaque per-session/day fingerprint — sha256(ip+ua+slug+day). No raw PII stored.
function sessionHashFor(req, slug) {
  const xff = req.headers["x-forwarded-for"];
  const ip = (xff && String(xff).split(",")[0].trim()) || req.ip || (req.socket && req.socket.remoteAddress) || "";
  const ua = req.headers["user-agent"] || "";
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash("sha256").update(`${ip}|${ua}|${slug}|${day}`).digest("hex");
}

// Coarse referrer class only (no URLs/paths retained).
function classifyReferer(ref) {
  if (!ref) return "direct";
  try {
    const h = new URL(ref).hostname.toLowerCase();
    if (/(google|bing|duckduckgo|yahoo)\./.test(h)) return "search";
    if (/(instagram|facebook|fb\.|t\.co|twitter|x\.com|pinterest|whatsapp|linkedin)/.test(h)) return "social";
    if (/wedsy\.in$/.test(h) || h === "wedsy.in") return "internal";
    return "referral";
  } catch {
    return "direct";
  }
}

// POST /venues/:slug/view — PUBLIC fire-and-forget view beacon. Always 200,
// never blocks the page. Deduped per session per day (one counted view).
const trackView = async (req, res) => {
  res.status(200).json({ success: true }); // respond immediately — never make the page wait
  try {
    const { slug } = req.params;
    if (!slug) return;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return;
    const sessionHash = sessionHashFor(req, slug);
    const source = classifyReferer(req.headers.referer || req.headers.referrer || (req.body && req.body.ref));
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dup = await VenueView.findOne({ venueId: venue._id, sessionHash, viewedAt: { $gte: startOfDay } }).select("_id").lean();
    if (dup) return;
    await VenueView.create({
      venueId: venue._id,
      venueSlug: slug,
      sessionHash,
      source,
      userId: (req.auth && req.auth.user_id) || undefined,
      viewedAt: new Date(),
    });
  } catch (_) {
    /* fire-and-forget — swallow */
  }
};

module.exports = { trackView, sessionHashFor, classifyReferer };

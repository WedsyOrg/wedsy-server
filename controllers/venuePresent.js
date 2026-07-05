/**
 * controllers/venuePresent.js — MB-V2 P1: PUBLIC present-mode.
 *
 * The couple opens a shared link; the 48-hex presentToken IS the credential
 * (typed + rate-limited upstream; regenerating the link rotates it). Exposes
 * venue cards + the react action — no PII beyond the couple's own first name,
 * no phone, no CRM ids, no admin fields.
 */
const VenueShortlist = require("../models/VenueShortlist");
const Venue = require("../models/Venue");

const TOKEN_RE = /^[a-f0-9]{48}$/;

const CARD_FIELDS = "name city zone venueType tagline pricing.perPlate coverPhoto spaces googleRating googleReviewCount";

const shapeCard = (venue) => {
  if (!venue) return null;
  const capacity = Math.max(0, ...(venue.spaces || []).map((s) => s.capacitySeated || 0));
  return {
    name: venue.name,
    city: venue.city || "",
    zone: venue.zone || "",
    venueType: venue.venueType || "",
    tagline: venue.tagline || "",
    perPlate: (venue.pricing && venue.pricing.perPlate) || null,
    coverPhoto: venue.coverPhoto || "",
    capacitySeated: capacity || null,
    googleRating: venue.googleRating || null,
    googleReviewCount: venue.googleReviewCount || null,
  };
};

const loadByToken = async (req, res) => {
  const token = String(req.params.token || "");
  if (!TOKEN_RE.test(token)) {
    res.status(400).json({ message: "Malformed present token" });
    return null;
  }
  const shortlist = await VenueShortlist.findOne({ presentToken: token });
  if (!shortlist) {
    res.status(404).json({ message: "This link is no longer active" });
    return null;
  }
  return shortlist;
};

// GET /venues/present/:token
const getPresentation = async (req, res) => {
  try {
    const shortlist = await loadByToken(req, res);
    if (!shortlist) return;
    const venues = await Venue.find({ _id: { $in: shortlist.items.map((i) => i.venue) } })
      .select(CARD_FIELDS)
      .lean();
    const byId = Object.fromEntries(venues.map((v) => [String(v._id), v]));
    return res.status(200).json({
      coupleName: shortlist.coupleName || "",
      items: shortlist.items.map((i) => ({
        itemId: i._id,
        venue: shapeCard(byId[String(i.venue)]),
        notes: i.notes || "",
        reaction: i.reaction || "",
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/present/:token/react  {itemId, reaction}
const react = async (req, res) => {
  try {
    const shortlist = await loadByToken(req, res);
    if (!shortlist) return;
    const body = req.body || {};
    if (!["love", "maybe", "no"].includes(body.reaction)) {
      return res.status(400).json({ message: "reaction must be love, maybe or no" });
    }
    const item = body.itemId ? shortlist.items.id(String(body.itemId)) : null;
    if (!item) return res.status(404).json({ message: "Unknown shortlist item" });
    item.reaction = body.reaction;
    item.status = "reacted";
    await shortlist.save();
    return res.status(200).json({ itemId: item._id, reaction: item.reaction });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getPresentation, react };

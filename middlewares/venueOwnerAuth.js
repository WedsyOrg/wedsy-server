const jwt = require("jsonwebtoken");
let VenueTeamMember;
try { VenueTeamMember = require("../models/VenueTeamMember"); } catch (_) {}

// Per-request guard: a team-member token is only valid while the member is still
// active and bound to the same venue. Rejects a deactivated member's live JWT.
async function memberStillValid(payload) {
  if (!payload.memberId) return true; // owner token — no membership to check
  if (!VenueTeamMember) return true; // model absent on pre-team branches
  const m = await VenueTeamMember.findById(payload.memberId).select("isActive venueId").lean();
  return Boolean(m && m.isActive && String(m.venueId) === String(payload.venueId));
}

function venueOwnerAuth(req, res, next) {
  if (!req.headers.authorization) {
    return res.status(401).json({ message: "No Auth Token" });
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token || token === "null") {
    return res.status(401).json({ message: "No Auth Token" });
  }
  jwt.verify(token, process.env.JWT_SECRET, async function (err, payload) {
    if (err) {
      return res.status(401).json({ message: "Invalid token", error: err.message });
    }
    // Gate by venueId, accepting BOTH owner tokens (venueOwnerId) and team-member
    // tokens (memberId). req.venueOwner surfaces venueId + role + memberId/venueOwnerId
    // for the downstream role gate. Owner = a member with role "owner".
    if (
      !payload ||
      payload.type !== "venue_owner" ||
      !payload.venueId ||
      (!payload.venueOwnerId && !payload.memberId)
    ) {
      return res.status(401).json({ message: "Invalid token" });
    }
    try {
      if (!(await memberStillValid(payload))) {
        return res.status(401).json({ message: "Member account is inactive" });
      }
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
    req.venueOwner = payload;
    next();
  });
}

module.exports = { venueOwnerAuth, memberStillValid };

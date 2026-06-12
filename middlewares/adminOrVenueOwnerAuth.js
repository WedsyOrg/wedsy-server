const jwt = require("jsonwebtoken");
const { memberStillValid } = require("./venueOwnerAuth");

// Accepts EITHER an admin token (payload.isAdmin === true, matching CheckAdminLogin)
// OR a venue_owner token (type "venue_owner"). Mirrors venueOwnerAuth's style and secret.
function adminOrVenueOwnerAuth(req, res, next) {
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
    if (payload && payload.isAdmin === true) {
      req.admin = payload;
      return next();
    }
    // Venue_owner path mirrors venueOwnerAuth: accept BOTH owner tokens
    // (venueOwnerId) and team-member tokens (memberId), but reject a deactivated
    // member's live JWT (per-request isActive check).
    if (payload && payload.type === "venue_owner" && payload.venueId && (payload.venueOwnerId || payload.memberId)) {
      try {
        if (!(await memberStillValid(payload))) {
          return res.status(401).json({ message: "Member account is inactive" });
        }
      } catch (e) {
        return res.status(500).json({ message: e.message });
      }
      req.venueOwner = payload;
      return next();
    }
    return res.status(401).json({ message: "Invalid token" });
  });
}

module.exports = { adminOrVenueOwnerAuth };

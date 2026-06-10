const jwt = require("jsonwebtoken");

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
  jwt.verify(token, process.env.JWT_SECRET, function (err, payload) {
    if (err) {
      return res.status(401).json({ message: "Invalid token", error: err.message });
    }
    if (payload && payload.isAdmin === true) {
      req.admin = payload;
      return next();
    }
    // Venue_owner path mirrors venueOwnerAuth: accept BOTH owner tokens
    // (venueOwnerId) and team-member tokens (memberId) so members with the
    // relevant capability pass the downstream requireCapabilityOrAdmin gate.
    if (payload && payload.type === "venue_owner" && payload.venueId && (payload.venueOwnerId || payload.memberId)) {
      req.venueOwner = payload;
      return next();
    }
    return res.status(401).json({ message: "Invalid token" });
  });
}

module.exports = { adminOrVenueOwnerAuth };

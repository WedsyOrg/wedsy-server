const jwt = require("jsonwebtoken");

function venueOwnerAuth(req, res, next) {
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
    if (!payload || payload.type !== "venue_owner" || !payload.venueOwnerId || !payload.venueId) {
      return res.status(401).json({ message: "Invalid token" });
    }
    req.venueOwner = payload;
    next();
  });
}

module.exports = { venueOwnerAuth };

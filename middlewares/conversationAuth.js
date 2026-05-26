const jwt = require("jsonwebtoken");
const User = require("../models/User");

function coupleOrVenueAuth(req, res, next) {
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
    if (!payload) {
      return res.status(401).json({ message: "Invalid token" });
    }
    if (payload.type === "venue_owner" && payload.venueOwnerId && payload.venueId) {
      req.venueOwner = payload;
      return next();
    }
    if (payload._id && !payload.isAdmin && !payload.isVendor) {
      try {
        const user = await User.findById(payload._id);
        if (!user) {
          return res.status(401).json({ message: "Invalid user" });
        }
        req.auth = {
          user_id: payload._id,
          user,
          isAdmin: false,
          isVendor: false,
        };
        return next();
      } catch (error) {
        return res.status(400).json({ message: "error", error: error.message });
      }
    }
    return res.status(401).json({ message: "Invalid token" });
  });
}

module.exports = { coupleOrVenueAuth };

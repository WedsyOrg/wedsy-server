const { roleHasCapability } = require("../utils/venueRoles");

// Route-level role gate, layered AFTER venueOwnerAuth (which sets req.venueOwner with
// role + memberId/venueOwnerId). Returns 401 if unauthenticated, 403 if the member's
// role lacks the capability. Owner has every capability.
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.venueOwner) return res.status(401).json({ message: "Not authenticated" });
    const role = req.venueOwner.role || "owner";
    if (!roleHasCapability(role, capability)) {
      return res.status(403).json({ message: `Your role (${role}) cannot perform this action` });
    }
    next();
  };
}

// Admin-aware variant for routes behind adminOrVenueOwnerAuth: a platform admin token
// (req.admin set by that middleware) BYPASSES the venue-role check entirely; venue
// tokens are role-checked exactly like requireCapability. Cleanly separable because
// adminOrVenueOwnerAuth sets req.admin XOR req.venueOwner.
function requireCapabilityOrAdmin(capability) {
  return (req, res, next) => {
    if (req.admin) return next(); // platform admin keeps full access
    if (!req.venueOwner) return res.status(401).json({ message: "Not authenticated" });
    const role = req.venueOwner.role || "owner";
    if (!roleHasCapability(role, capability)) {
      return res.status(403).json({ message: `Your role (${role}) cannot perform this action` });
    }
    next();
  };
}

module.exports = { requireCapability, requireCapabilityOrAdmin };

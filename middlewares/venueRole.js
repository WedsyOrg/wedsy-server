const { hasCapability } = require("../utils/venueRbac");

// Route-level capability gate, layered AFTER venueOwnerAuth (which sets
// req.venueOwner and, for member tokens, req.venueMember — the fresh member
// doc). RBAC v2 (D5): owner tokens hold every capability; member tokens
// resolve through their VenueRole bundle, falling back to the legacy static
// map for unmigrated members. 401 unauthenticated, 403 capability missing.
function requireCapability(capability) {
  return async (req, res, next) => {
    if (!req.venueOwner) return res.status(401).json({ message: "Not authenticated" });
    try {
      if (await hasCapability(req.venueOwner, capability, req.venueMember)) return next();
      return res.status(403).json({ message: `Your role cannot perform this action (needs: ${capability})` });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  };
}

// Admin-aware variant for routes behind adminOrVenueOwnerAuth: a platform admin
// token (req.admin set by that middleware) BYPASSES the venue-role check
// entirely; venue tokens are capability-checked exactly like requireCapability.
// Cleanly separable because adminOrVenueOwnerAuth sets req.admin XOR req.venueOwner.
function requireCapabilityOrAdmin(capability) {
  return async (req, res, next) => {
    if (req.admin) return next(); // platform admin keeps full access
    if (!req.venueOwner) return res.status(401).json({ message: "Not authenticated" });
    try {
      if (await hasCapability(req.venueOwner, capability, req.venueMember)) return next();
      return res.status(403).json({ message: `Your role cannot perform this action (needs: ${capability})` });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  };
}

module.exports = { requireCapability, requireCapabilityOrAdmin };

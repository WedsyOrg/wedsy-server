const jwt = require("jsonwebtoken");

// SOFT auth for the PUBLIC GET /venues route. MUST NEVER reject — unauthenticated
// couples on wedsy.in call this. Attaches req.admin only when a valid admin token
// is present; otherwise just continues with no req.admin. Never sends a 4xx/5xx.
function optionalAdminAuth(req, res, next) {
  try {
    if (!req.headers.authorization) return next();
    const token = req.headers.authorization.split(" ")[1];
    if (!token || token === "null") return next();
    jwt.verify(token, process.env.JWT_SECRET, function (err, payload) {
      if (!err && payload && payload.isAdmin === true) {
        req.admin = payload;
      }
      // Always continue — invalid / non-admin tokens are silently ignored.
      return next();
    });
  } catch (e) {
    // Swallow any unexpected error and continue unauthenticated.
    return next();
  }
}

module.exports = { optionalAdminAuth };

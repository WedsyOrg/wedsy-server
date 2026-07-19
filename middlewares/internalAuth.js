// L1/L4 — the INTERNAL INGEST SEAM. Producers are either OS admins (normal
// admin JWT) or, later, the wedsy-user backend calling service-to-service with
// the shared-secret header. Secret path: `x-internal-secret` must equal
// process.env.INTERNAL_INGEST_SECRET (route stays admin-JWT-only while the env
// is unset — fail closed, never open).
const { CheckAdminLogin } = require("./auth");

const InternalOrAdmin = (req, res, next) => {
  const secret = process.env.INTERNAL_INGEST_SECRET;
  const presented = req.headers["x-internal-secret"];
  if (secret && presented && presented === secret) {
    req.internal = true;
    req.auth = { user_id: null, user: null, isAdmin: false, internal: true };
    return next();
  }
  return CheckAdminLogin(req, res, next);
};

module.exports = { InternalOrAdmin };

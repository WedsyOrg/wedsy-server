const { permissionsForAdmin } = require("./requirePermission");

// ───────────────────────────────────────────────────────────────────────────
// READ-ONLY ACCOUNTS.
//
// An admin holding the marker permission `access:readonly:all` may issue SAFE
// HTTP METHODS ONLY. Anything that can write — DELETE, POST, PUT, PATCH — is
// refused before it reaches a handler.
//
// WHY A BLANKET METHOD RULE RATHER THAN PER-ROUTE PERMISSIONS. Of the 108
// delete routes in this codebase, 8 carry requirePermission and 100 are
// CheckAdminLogin only — DELETE /enquiry (lead delete) among them. A
// per-capability grant therefore cannot express "this account must not delete
// anything": there is nothing on those 100 routes for a permission to gate
// against. This guard sits at the one place every authenticated request passes
// through and closes all of them at once.
//
// That ungated majority is a real problem for EVERY account in production, not
// only this one — any authenticated admin holding zero permissions can delete
// any lead today. This guard does not fix that; it makes one account safe.
// The general fix is tracked separately and must not be considered handled
// because this exists.
//
// BLAST RADIUS IS DELIBERATELY TINY. The rule is opt-IN: it fires only for an
// account explicitly granted the marker. No existing role carries it, so no
// current user's behaviour changes by a single request. The inverse design —
// "deny writes unless a delete permission is held" — would be the correct
// long-term shape and would instantly break almost every account in production,
// since hardly any role grants delete. That inversion is the separate ticket,
// not this middleware.
//
// It is also defence in depth, never the only lock: the reviewer role withholds
// `leads:edit`, so sending a DM is already refused by requirePermission on its
// own. This catches the routes that have no permission to withhold.
// ───────────────────────────────────────────────────────────────────────────

const READONLY_PERMISSION = "access:readonly:all";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Runs after req.auth is populated. Calls next() to allow, or answers 403.
const enforceReadOnly = async (req, res, next) => {
  try {
    // Fast path: a safe method needs no lookup at all. This also keeps the cost
    // off the read traffic that makes up most requests — the role query below
    // only ever runs on a write attempt.
    if (SAFE_METHODS.has(req.method)) return next();

    const admin = req.auth && req.auth.user;
    if (!admin) return next(); // not our call to make — CheckAdminLogin owns auth

    const perms = await permissionsForAdmin(admin);
    // Exact string match, NOT permissionSatisfies(): a wildcard grant like
    // `*:*:all` (Founder) would otherwise "satisfy" the marker and lock the
    // founder out of the entire product. The marker is a literal flag, not a
    // capability to be inherited.
    if (!perms.includes(READONLY_PERMISSION)) return next();

    console.warn(
      `[readonly] blocked ${req.method} ${req.originalUrl} for read-only admin ${admin._id}`
    );
    return res.status(403).json({
      message: "This account is read-only and cannot make changes.",
    });
  } catch (error) {
    // FAIL CLOSED on a write. If we cannot prove the account may write, it may
    // not — the opposite default would turn a database blip into a deletion.
    console.error("[readonly] check failed — refusing the write:", error.message);
    return res.status(403).json({ message: "This account is read-only and cannot make changes." });
  }
};

module.exports = { enforceReadOnly, READONLY_PERMISSION, SAFE_METHODS };

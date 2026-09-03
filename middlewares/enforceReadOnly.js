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

// ───────────────────────────────────────────────────────────────────────────
// READ ALLOWLIST — which GETs a marker-holding account may make.
//
// WHY THIS EXISTS. Withholding permissions does not limit what an account can
// READ: 275 of this repo's 361 GET routes are CheckAdminLogin only and consult
// no permission at all. Without an allowlist a "Sales" read-only account can
// read the full staff directory, every task in every department, and the whole
// venue-ops surface — not because it was granted anything, but because those
// routes never ask. Raised separately as its own issue; this fixes ONE ACCOUNT
// and nothing else.
//
// WHY IT IS SAFE TO SHIP NOW, which is the reason it is worth doing rather than
// deferring behind the general fix: it is reachable ONLY by an account holding
// access:readonly:all. No existing role carries that marker, so the blast
// radius of a mistake in this list is exactly one account — the reviewer's. A
// wrong entry costs that reviewer a 403 on a page; it cannot affect a single
// member of staff. The general fix (gating those 275 routes properly) has the
// opposite risk profile and needs the care that deserves.
//
// DENY BY DEFAULT, ALLOW BY ENUMERATION. Anything not matched below is refused.
// A denylist would silently admit every route added after it was written; this
// fails closed on them instead. When a reviewer hits a wall, the console line
// names the exact path, so widening the list is a one-line, evidence-led edit
// rather than guesswork.
//
// SCOPE: Sales only — leads, enquiries, pipeline, chats and the Instagram
// surface, plus the lookups those screens need to render. Deliberately absent:
// /task, /admin (staff directory), /admin/venues, /project, /settings, /role,
// /department, /org, /team, /cs, /payment, /settlements, /payroll, /attendance,
// /leave, /reimbursement, /onboarding, /plan, /stats.
//
// TWO REFUSALS THAT ARE DELIBERATE AND WILL LOOK LIKE BUGS. Do not "fix" either
// by adding it here:
//
//   GET /admin (and /admin?assignable=true) — the STAFF DIRECTORY. It stays
//   blocked by explicit decision. The consequence is that the assignment
//   dropdown on a lead renders empty, which is acceptable precisely because
//   this account cannot assign anything anyway.
//
//   POST /attendance/heartbeat — a write, refused by the method rule above, and
//   the frontend polls it, so it will keep appearing in the logs. That noise is
//   the correct behaviour of a read-only account, not a defect. If it matters,
//   the frontend stops polling it for this role; the guard does not soften.
//   Note /attendance/me IS allowed — own attendance, read-only — while the rest
//   of /attendance is not: the entry is the exact path, not the prefix.
// ───────────────────────────────────────────────────────────────────────────
const READ_ALLOWLIST = [
  // — the account's own session and identity —
  "/auth/admin",              // GET: who am I
  "/auth/admin/permissions",  // drives which controls the UI renders at all
  "/me",                      // own profile / workspace switcher

  // — the Instagram surface: the entire point of the review —
  "/instagram-agent",         // connected-account panel + GET /connect

  // — app shell —
  // Read by every screen before anything renders. Denying these does not hide
  // data, it produces a visibly broken product — which is a worse outcome in
  // front of a reviewer than any data question this allowlist exists to answer.
  "/settings/public",         // public config; NOT /settings, which stays denied
  "/admin-notifications",     // the bell; self-scoped to the caller (listMine)
  "/attendance/me",           // own attendance only — the shell reads it on load

  // — leads, conversations, pipeline, chats —
  "/enquiry",
  "/lead-tasks",              // lead DETAIL calls this; without it a lead cannot be opened
  "/wa",                      // the agent inbox (conversations + messages)
  "/chat",
  "/stages",                  // pipeline columns; the board renders nothing without them

  // — the lead DETAIL screen —
  // Every entry below is a route the CRM's lead-detail page actually calls
  // (read out of the frontend's authedFetch call sites, not guessed). Without
  // them a lead lists but will not open, which is the most visible possible
  // failure in front of a reviewer.
  "/event",                   // lead events; /event/:id is the detail panel
  "/event-mandatory-question",
  "/color",                   // décor pickers embedded in lead detail
  "/plan/themes",             // planner theme catalogue (NOT /plan/internal/*)
  // Décor catalogue and drafts. Store-side data rather than Sales, admitted
  // deliberately: it is product catalogue, not client PII, and the lead-detail
  // planner renders broken without it. Reads only — the method rule above still
  // refuses every décor write.
  "/decor",
  "/decor-package",

  // — lookups the lead screens need to render filters and labels —
  // Config vocabularies, not client data. Without these the Sales screens load
  // with empty dropdowns and look broken to a reviewer.
  "/lead-source",
  "/lead-interest",
  "/lead-lost-response",
  "/event-type",
  "/event-lost-response",
  "/location",
  "/custom-field",
  "/saved-views",
  "/tag",
];

// Prefix match on the ORIGINAL url (the app mounts its router at "/", so
// originalUrl maps straight onto the mount table in routes/router.js). req.path
// is relative to whichever sub-router is running and would not.
//
// The boundary check is what stops "/task" being admitted by an entry for
// "/ta": a match must be the whole path or be followed by "/" or "?".
const isAllowedRead = (originalUrl) => {
  const path = String(originalUrl || "").split("?")[0].replace(/\/+$/, "") || "/";
  return READ_ALLOWLIST.some((entry) => {
    if (path === entry) return true;
    return path.startsWith(entry + "/");
  });
};

// Exact string match, NOT permissionSatisfies(): a wildcard grant like `*:*:all`
// (Founder) would otherwise "satisfy" the marker and lock the founder out of the
// entire product. The marker is a literal flag, not a capability to be inherited.
const isReadOnly = async (admin) => {
  const perms = await permissionsForAdmin(admin);
  return perms.includes(READONLY_PERMISSION);
};

// Runs after req.auth is populated. Calls next() to allow, or answers 403.
const enforceReadOnly = async (req, res, next) => {
  try {
    const admin = req.auth && req.auth.user;
    if (!admin) return next(); // not our call to make — CheckAdminLogin owns auth

    const safe = SAFE_METHODS.has(req.method);

    // One lookup, then out. Unlike the write-only version of this guard, a
    // marker-holder's READS must be checked too, so the safe-method fast path
    // is gone — but the cost still lands only on accounts carrying the marker,
    // and every other account leaves on the next line.
    if (!(await isReadOnly(admin))) return next();

    if (safe) {
      if (isAllowedRead(req.originalUrl)) return next();
      // Named explicitly so widening the allowlist is evidence-led: whatever
      // the reviewer could not reach is in the log, exactly as requested.
      console.warn(
        `[readonly] blocked READ ${req.originalUrl} for read-only admin ${admin._id} (not on allowlist)`
      );
      return res.status(403).json({
        message: "This account does not have access to that area.",
      });
    }

    console.warn(
      `[readonly] blocked ${req.method} ${req.originalUrl} for read-only admin ${admin._id}`
    );
    return res.status(403).json({
      message: "This account is read-only and cannot make changes.",
    });
  } catch (error) {
    // FAIL CLOSED. If we cannot prove what this account may do, it may do
    // nothing — the opposite default would turn a database blip into a deletion
    // or an unintended disclosure.
    console.error("[readonly] check failed — refusing the request:", error.message);
    return res.status(403).json({ message: "This account could not be verified for that action." });
  }
};

module.exports = { enforceReadOnly, READONLY_PERMISSION, SAFE_METHODS, READ_ALLOWLIST, isAllowedRead };

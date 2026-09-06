const ActivityLogService = require("../services/ActivityLogService");

// ───────────────────────────────────────────────────────────────────────────
// AUDIT TRAIL FOR DESTRUCTIVE REQUESTS.
//
// Of the 66 ungated admin-reachable DELETE routes found on 6 Sep, ALL 66 were
// unlogged: a deletion left no trace of who did it. A gate stops the wrong
// person; a log tells you what happened — and the log is the only one of the two
// that helps AFTER the fact.
//
// WHY THIS SITS AT THE AUTH CHOKEPOINT rather than on 66 routes. Recording WHO
// deleted WHAT presupposes no decision about who MAY delete what — so it can
// land while those product questions are still open, and it cannot collide with
// whatever grouping is chosen later. Retrofitting 66 route edits would both
// preempt those decisions and miss route 67.
//
// WHAT IS WRITTEN: actor, action, entity type and id, a human summary, and meta
// carrying the path, the route params and the RESPONSE STATUS.
//
// WHAT IS NEVER WRITTEN: the request body. A delete payload can carry names,
// phone numbers, or the ids of people other than the actor. The path and params
// are enough to say what was targeted; the body is not needed to say it and
// cannot be safely retained. This is an audit trail, not traffic capture.
//
// WHEN: on response finish, so the OUTCOME is recorded. A refused attempt (403)
// is as interesting as a successful one — arguably more so, since it is the
// shape of someone probing.
//
// Reads are not logged. Logging every GET would bury the destructive rows in
// noise and turn an audit trail into a traffic dump.
//
// FIRE-AND-SAFE, twice over: ActivityLogService.record swallows its own errors,
// and this never awaits the write. An audit failure must never fail a request —
// the alternative is a broken product every time the log store hiccups.
// ───────────────────────────────────────────────────────────────────────────

const DESTRUCTIVE_METHODS = new Set(["DELETE"]);

// DESTRUCTIVE ROUTES THAT ARE NOT DELETEs. Method alone cannot find these: they
// are POSTs and PUTs that destroy or retire data, and logging every POST would
// be traffic capture rather than an audit trail — the noise would bury the rows
// that matter.
//
// So the list is explicit and evidence-based, taken from the routes that
// actually destroy something, not from a guess at what might. It is NOT a
// grouping decision (those eight questions are still open) — it is only "does
// this request destroy data", which is answerable by reading the handler.
//
// Add to it when you add a destructive non-DELETE route. If you are unsure
// whether yours belongs, it does: an over-logged route costs a row, an
// unlogged one costs the answer to "who did this".
const DESTRUCTIVE_PATHS = [
  /^\/enquiry\/bulk-archive\b/,                       // soft-deletes leads in bulk
  /^\/enquiry\/bulk-lost\b/,                          // marks leads lost in bulk
  /^\/attribute\/[^/]+\/remove\b/,
  /^\/reimbursement\/[^/]+\/receipt\/remove\b/,
  /\/items\/remove-not-included\b/,
];

const isDestructive = (req) => {
  if (DESTRUCTIVE_METHODS.has(req.method)) return true;
  if (req.method !== "POST" && req.method !== "PUT") return false;
  const path = String(req.originalUrl || "").split("?")[0];
  return DESTRUCTIVE_PATHS.some((re) => re.test(path));
};

// A path like "/enquiry/123/milestones/456" → entityType "enquiry". The first
// segment is the mount, which is the entity in this codebase's route layout.
const entityTypeOf = (originalUrl) => {
  const path = String(originalUrl || "").split("?")[0];
  const seg = path.split("/").filter(Boolean)[0];
  return seg ? seg.toLowerCase() : "unknown";
};

// The most specific id the route named. params are route-derived, never body.
const entityIdOf = (req) => {
  const p = (req && req.params) || {};
  const keys = Object.keys(p);
  if (!keys.length) return null;
  const preferred = keys.find((k) => /^(_?id|.*Id)$/i.test(k)) || keys[keys.length - 1];
  return p[preferred] != null ? String(p[preferred]) : null;
};

const auditDestructive = (req, res, next) => {
  try {
    if (!isDestructive(req)) return next();
    const actorId = (req.auth && req.auth.user_id) || (req.admin && req.admin._id) || null;

    res.on("finish", () => {
      try {
        const path = String(req.originalUrl || "").split("?")[0];
        ActivityLogService.record({
          actorId,
          action: `${entityTypeOf(req.originalUrl)}.${req.method === "DELETE" ? "delete" : "destructive"}`,
          entityType: entityTypeOf(req.originalUrl),
          entityId: entityIdOf(req),
          summary: `${req.method} ${path} → ${res.statusCode}`,
          // params only — deliberately NOT req.body. See the note above.
          meta: { path, method: req.method, status: res.statusCode, params: req.params || {} },
        });
      } catch (_) { /* never let an audit write disturb a completed response */ }
    });
  } catch (_) { /* nor a failure to register the hook */ }
  return next();
};

module.exports = { auditDestructive, entityTypeOf, entityIdOf, isDestructive, DESTRUCTIVE_PATHS };

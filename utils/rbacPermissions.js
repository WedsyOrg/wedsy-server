/**
 * RBAC permission vocabulary + validation. Single source of truth on the server.
 * A permission string is "resource:action:scope":
 *   resource in RESOURCES or "*"
 *   action   in ACTIONS or "*"
 *   scope    in SCOPES (concrete only — no "*")
 */

const RESOURCES = [
  "leads", "projects", "tasks", "content", "internal_ops",
  "attendance", "incentives", "users", "roles", "reports", "settings",
  // Settings Suite — per-category settings permissions (action "edit", scope "all").
  "settings_pipeline", "settings_fields", "settings_assignment", "settings_sla",
  "settings_cadence", "settings_reasons", "settings_integrations",
  "settings_templates", "settings_roles",
  // Kiara (WhatsApp AI agent) brain — founder-only by policy (granted via the
  // founder role's *:*:all wildcard; never seeded to other roles).
  "settings_kiara",
  "settings_moods",
  // HR / attendance policy (start time, grace, late bands, working days).
  "settings_hr",
  // ── Payroll (2026-08-21) ──────────────────────────────────────────────────
  // Deliberately SEPARATE from `attendance`. Seeing someone's check-in time and
  // seeing their net pay are different privileges, and collapsing them would
  // give every manager who can see a team roster access to salaries.
  "payroll",
  "settings_planner",
  // ── MB-OSV — the OS Venue department ──────────────────────────────────────
  // One resource per venue-team job, so the work can be split by assignment
  // later without redesigning the vocabulary. One person holds all of these
  // today; that is a staffing fact, not a schema constraint.
  //   venues              — see the venue department at all (directory, 360)
  //   venues_enrich       — Track A: fill in and score venue data
  //   venues_verify       — Track A terminal: the verification call
  //   venues_visit        — Track B: log partner visits
  //   venues_onboard      — Track B: grant access, set terms, advance onboarding
  //   venues_leads_assist — the "Leads I'm on" join
  "venues",
  "venues_enrich",
  "venues_verify",
  "venues_visit",
  "venues_onboard",
  "venues_leads_assist",
  // Auspicious (muhurat) dates — PLATFORM reference data, not venue-owned.
  // A date being auspicious drives demand at every venue at once, so the
  // vocabulary sits alongside the venue jobs (the venue team enters it) while
  // the data itself is consumed by the owner portal and the couple site too.
  // Held as its own resource so entering the calendar can be delegated without
  // handing out venues_onboard.
  "auspicious_dates_manage",
  // ── A2S (Add to Store) — the décor catalogue publish gate ──────────────────
  // "store:approve:all" is the ONLY permission on this resource today: it gates
  // the A2S draft approve/reject actions AND the direct décor write routes
  // (create / edit / delete / reorder), so the approval queue cannot be
  // bypassed by posting straight to /decor.
  // Deliberately reuses the EXISTING "approve" action rather than adding a
  // "publish" verb — ACTIONS is a global vocabulary, so a new verb would make
  // "leads:publish:all" (and every other resource pairing) expressible but
  // meaningless. Resource-only addition keeps the matrix honest.
  "store",
];
const ACTIONS = ["view", "create", "edit", "delete", "assign", "export", "approve"];
const SCOPES = ["own", "team", "department", "all"];

function validatePermissions(permissions) {
  const errors = [];
  if (!Array.isArray(permissions)) {
    return { valid: false, errors: ["permissions must be an array of strings"] };
  }
  for (const p of permissions) {
    if (typeof p !== "string") {
      errors.push(`not a string: ${JSON.stringify(p)}`);
      continue;
    }
    const parts = p.split(":");
    if (parts.length !== 3) {
      errors.push(`malformed (expected resource:action:scope): "${p}"`);
      continue;
    }
    const [resource, action, scope] = parts;
    if (resource !== "*" && !RESOURCES.includes(resource)) errors.push(`unknown resource in "${p}"`);
    if (action !== "*" && !ACTIONS.includes(action)) errors.push(`unknown action in "${p}"`);
    if (!SCOPES.includes(scope)) errors.push(`invalid scope in "${p}" (must be one of ${SCOPES.join("|")})`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { RESOURCES, ACTIONS, SCOPES, validatePermissions };

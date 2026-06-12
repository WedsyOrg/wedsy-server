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

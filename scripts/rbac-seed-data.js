/**
 * RBAC Phase 2B — Seed data (pure data module).
 *
 * Single source of truth for the default departments + roles (with permissions)
 * used by the RBAC seed scripts. NO side effects: this module does not connect to
 * a DB, read env, or execute anything at import time — it only exports data.
 *
 * Consumers:
 *   - scripts/rbac-phase-2b-seed-roles.js       (LOCAL dev seed)
 *   - scripts/rbac-phase-2b-seed-roles-PROD.js  (PROD seed, deploy-window only)
 */

const DEPARTMENTS = [
  { name: "Founders", description: "Founders and company leadership" },
  { name: "Sales", description: "Lead conversion and pipeline" },
  { name: "Operations", description: "Project execution and delivery" },
  { name: "Client Servicing", description: "Client relationship and account management" },
];

const ROLES = [
  { name: "Founder", department: "Founders", permissions: ["*:*:all"] },
  { name: "CRM Admin", department: "Founders", permissions: ["users:*:all", "roles:*:all", "settings:*:all"] },
  { name: "Revenue Head", department: "Sales", permissions: ["leads:view:team", "leads:edit:team", "leads:assign:team"] },
  { name: "Sales Manager", department: "Sales", permissions: ["leads:view:team", "leads:edit:team", "leads:assign:team"] },
  { name: "Sales Executive", department: "Sales", permissions: ["leads:view:own", "leads:edit:own"] },
  { name: "Operations Manager", department: "Operations", permissions: ["projects:view:department", "tasks:view:department"] },
  { name: "Operations Executive", department: "Operations", permissions: ["projects:view:own", "tasks:view:own"] },
  { name: "Client Servicing Manager", department: "Client Servicing", permissions: ["projects:view:team", "tasks:view:team"] },
  { name: "Client Servicing Executive", department: "Client Servicing", permissions: ["projects:view:own", "tasks:view:own"] },
];

module.exports = { DEPARTMENTS, ROLES };

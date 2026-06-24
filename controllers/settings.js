const SettingsService = require("../services/SettingsService");
const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const { permissionSatisfies, permissionsForAdmin } = require("../middlewares/requirePermission");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[settings]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Caller's resolved permission strings — RBAC v2 union across all roles.
const callerPermissions = async (adminId) => {
  const admin = await AdminRepository.findById(adminId);
  return permissionsForAdmin(admin);
};

const canEditCategory = (perms, category) =>
  permissionSatisfies(perms, `${category}:edit:all`).allowed;

// GET /settings?category=settings_assignment — gated by THAT category's permission.
const GetCategory = async (req, res) => {
  try {
    const category = req.query.category;
    if (!category) return res.status(400).json({ message: "category is required" });
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, category)) {
      return res.status(403).json({ message: "Forbidden", required: `${category}:edit:all` });
    }
    const values = await SettingsService.getCategory(category);
    res.status(200).json({ category, values, defaults: SettingsService.DEFAULTS });
  } catch (error) {
    respond(res, error);
  }
};

// PUT /settings { key, value } — the key's category decides the gate.
const Put = async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (typeof key !== "string") return res.status(400).json({ message: "key is required" });
    const category = SettingsService.categoryForKey(key);
    if (!category) return res.status(400).json({ message: `Unknown setting key: ${key}` });
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, category)) {
      return res.status(403).json({ message: "Forbidden", required: `${category}:edit:all` });
    }
    const stored = await SettingsService.set(key, value, req.auth.user_id);
    res.status(200).json({ key, value: stored });
  } catch (error) {
    respond(res, error);
  }
};

// GET /settings/public — read-only operational values any logged-in admin needs
// (cockpit templates, tag library, golden display numbers). No category gate.
const GetPublic = async (req, res) => {
  try {
    const values = await SettingsService.getMany([
      "whatsapp.templates",
      "tags.available",
      "golden.windowMinutes",
      // MB9c — the speed-to-lead SLA duration drives the in-row golden-window clock.
      "sla.goldenWindowMinutes",
      "golden.workStartHour",
      "golden.workEndHour",
      // MB6 Slice 6: the cockpit reads these without settings permissions.
      "services.available",
      "cockpit.briefScript",
      "cockpit.servicesScript",
      "cockpit.budgetScript",
      "cockpit.qualificationIntro",
      // MB7a Slice 3: the onboard flow (and wedsy-user) read the agreement text.
      "agreement.terms",
      "agreement.version",
    ]);
    res.status(200).json(values);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { GetCategory, Put, GetPublic, callerPermissions };

const SettingsService = require("../services/SettingsService");
const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const { permissionSatisfies, permissionsForAdmin } = require("../middlewares/requirePermission");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[settings]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong saving settings — please retry." : error.message });
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

// ── Slice B5b — Agreement & Billing (one whole-category surface) ─────────────
const BILLING = "settings_billing";

// GET /settings/billing — every billing.* + broadcast.* key with effective values.
const GetBilling = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, BILLING)) {
      return res.status(403).json({ message: "Forbidden", required: `${BILLING}:edit:all` });
    }
    res.status(200).json({ values: await SettingsService.getCategory(BILLING) });
  } catch (error) {
    respond(res, error);
  }
};

// PUT /settings/billing { "<key>": <value>, … } — billing-category keys only.
const PutBilling = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, BILLING)) {
      return res.status(403).json({ message: "Forbidden", required: `${BILLING}:edit:all` });
    }
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length) return res.status(400).json({ message: "No settings in body" });
    for (const key of keys) {
      if (SettingsService.categoryForKey(key) !== BILLING) {
        return res.status(400).json({ message: `${key} is not a billing setting` });
      }
    }
    for (const key of keys) await SettingsService.set(key, body[key], req.auth.user_id);
    res.status(200).json({ values: await SettingsService.getCategory(BILLING) });
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

// ── Journey v2 (V5) — the engagement content library (whole-category surface,
// same shape as billing: gated by settings_engagement:edit:all).
const ENGAGEMENT = "settings_engagement";

const GetEngagement = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, ENGAGEMENT)) {
      return res.status(403).json({ message: "Forbidden", required: `${ENGAGEMENT}:edit:all` });
    }
    res.status(200).json({ values: await SettingsService.getCategory(ENGAGEMENT) });
  } catch (error) {
    respond(res, error);
  }
};

const PutEngagement = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, ENGAGEMENT)) {
      return res.status(403).json({ message: "Forbidden", required: `${ENGAGEMENT}:edit:all` });
    }
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length) return res.status(400).json({ message: "No settings in body" });
    for (const key of keys) {
      if (SettingsService.categoryForKey(key) !== ENGAGEMENT) {
        return res.status(400).json({ message: `${key} is not an engagement setting` });
      }
    }
    for (const key of keys) await SettingsService.set(key, body[key], req.auth.user_id);
    res.status(200).json({ values: await SettingsService.getCategory(ENGAGEMENT) });
  } catch (error) {
    respond(res, error);
  }
};

// Planner P1 (P6) — the mood library, same whole-category surface as engagement.
const MOODS = "settings_moods";
const GetMoods = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, MOODS)) {
      return res.status(403).json({ message: "Forbidden", required: `${MOODS}:edit:all` });
    }
    res.status(200).json({ values: await SettingsService.getCategory(MOODS) });
  } catch (error) {
    respond(res, error);
  }
};
const PutMoods = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, MOODS)) {
      return res.status(403).json({ message: "Forbidden", required: `${MOODS}:edit:all` });
    }
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length) return res.status(400).json({ message: "No settings in body" });
    for (const key of keys) {
      if (SettingsService.categoryForKey(key) !== MOODS) {
        return res.status(400).json({ message: `${key} is not a moods setting` });
      }
    }
    for (const key of keys) await SettingsService.set(key, body[key], req.auth.user_id);
    res.status(200).json({ values: await SettingsService.getCategory(MOODS) });
  } catch (error) {
    respond(res, error);
  }
};

// Auto-assign exclusions — the pool read the Settings FE renders: every
// member of every pool/overflow role (disabled INCLUDED, flagged) with their
// exclusion state. Same gate as the assignment settings.
const ASSIGNMENT = "settings_assignment";
const GetAutoAssignPool = async (req, res) => {
  try {
    const perms = await callerPermissions(req.auth.user_id);
    if (!canEditCategory(perms, ASSIGNMENT)) {
      return res.status(403).json({ message: "Forbidden", required: `${ASSIGNMENT}:edit:all` });
    }
    const Role = require("../models/Role");
    const Admin = require("../models/Admin");
    const cfg = await SettingsService.getMany([
      "assignment.poolRoles",
      "assignment.overflowRoles",
      "assignment.excludedAdminIds",
    ]);
    const roleNames = [...cfg["assignment.poolRoles"], ...cfg["assignment.overflowRoles"]];
    const excluded = new Set((cfg["assignment.excludedAdminIds"] || []).map(String));
    const roles = await Role.find({ name: { $in: roleNames }, deletedAt: null }, { name: 1 }).lean();
    const roleById = new Map(roles.map((r) => [String(r._id), r.name]));
    const members = roles.length
      ? await Admin.find(
          { $or: [{ roleId: { $in: roles.map((r) => r._id) } }, { roleIds: { $in: roles.map((r) => r._id) } }] },
          { name: 1, status: 1, isDisabled: 1, roleId: 1 }
        ).sort({ name: 1 }).lean()
      : [];
    res.status(200).json({
      roles: roleNames,
      excludedAdminIds: [...excluded],
      members: members.map((m) => ({
        adminId: String(m._id),
        name: m.name,
        role: m.roleId ? roleById.get(String(m.roleId)) || null : null,
        status: m.status,
        isDisabled: !!m.isDisabled,
        excluded: excluded.has(String(m._id)),
      })),
    });
  } catch (error) {
    respond(res, error);
  }
};

// Addendum A1 — THEMES (Settings → Planner → Themes). Model-backed CRUD (the
// learning loop mutates taggedDecorIds outside settings), settings_planner gate.
const PLANNER = "settings_planner";
const themeGate = async (req, res) => {
  const perms = await callerPermissions(req.auth.user_id);
  if (!canEditCategory(perms, PLANNER)) {
    res.status(403).json({ message: "Forbidden", required: `${PLANNER}:edit:all` });
    return false;
  }
  return true;
};
const ThemeService = require("../services/ThemeService");
const ListThemes = async (req, res) => {
  try {
    if (!(await themeGate(req, res))) return;
    res.status(200).json({ themes: await ThemeService.list({ eventType: req.query.eventType, includeInactive: true }) });
  } catch (error) { respond(res, error); }
};
const CreateTheme = async (req, res) => {
  try {
    if (!(await themeGate(req, res))) return;
    res.status(201).json({ theme: await ThemeService.create(req.body || {}, req.auth.user_id) });
  } catch (error) { respond(res, error); }
};
const PatchTheme = async (req, res) => {
  try {
    if (!(await themeGate(req, res))) return;
    res.status(200).json({ theme: await ThemeService.patch(req.params.id, req.body || {}) });
  } catch (error) { respond(res, error); }
};
const DeleteTheme = async (req, res) => {
  try {
    if (!(await themeGate(req, res))) return;
    res.status(200).json(await ThemeService.remove(req.params.id));
  } catch (error) { respond(res, error); }
};

module.exports = { GetCategory, Put, GetPublic, callerPermissions, GetBilling, PutBilling, GetEngagement, PutEngagement, GetMoods, PutMoods, GetAutoAssignPool, ListThemes, CreateTheme, PatchTheme, DeleteTheme };

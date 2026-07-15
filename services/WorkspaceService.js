// W1 — WORKSPACES. The department switcher's data: which department
// workspaces the caller may enter, which is home, which they entered last.
// Derive-on-read over the EXISTING org model (Admin.departmentId + hats[] +
// Department docs) — nothing new is stored except Admin.lastWorkspaceId
// (whitelisted $set via setWorkspace).
const mongoose = require("mongoose");
const Department = require("../models/Department");
const Admin = require("../models/Admin");
const Role = require("../models/Role");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// Day-one departments, keyed by slug (Department.slug is the W1 additive
// field; legacy departments key off a slugified name instead).
const DAY_ONE = [
  { slug: "sales", name: "Sales" },
  { slug: "venues", name: "Venues" },
  { slug: "client_servicing", name: "Client Servicing" },
];

const slugify = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

// Idempotent, keyed by slug: for each day-one department — reuse the doc that
// already carries the slug; else stamp the slug onto an existing same-name
// department; else create it. Safe to call repeatedly (never duplicates).
const seedDayOneDepartments = async () => {
  const results = [];
  for (const d of DAY_ONE) {
    let doc = await Department.findOne({ slug: d.slug, deletedAt: null }).lean();
    if (!doc) {
      const byName = await Department.findOne({
        name: new RegExp(`^${d.name}$`, "i"),
        deletedAt: null,
      });
      if (byName) {
        if (!byName.slug) {
          byName.slug = d.slug;
          await byName.save();
        }
        doc = byName.toObject();
      } else {
        doc = (await Department.create({ name: d.name, slug: d.slug, isSystem: true })).toObject();
      }
    }
    results.push(doc);
  }
  return results;
};

// Fresh-DB guard: only auto-seed when there are no departments at all.
const ensureSeedIfEmpty = async () => {
  const count = await Department.countDocuments({ deletedAt: null });
  if (count === 0) await seedDayOneDepartments();
};

// Role facts for the caller: founder (systemKey/`*:*:all`) and Revenue Head
// (by role name — the same detection TriageService uses) both enter every
// workspace; everyone else gets their hat departments.
const callerRoleFacts = async (admin) => {
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const ids = roleIdsOf(admin);
  const roles = ids.length ? await Role.find({ _id: { $in: ids }, deletedAt: null }).lean() : [];
  const { isFounderRole } = require("./RoleService");
  return {
    isFounder: roles.some(isFounderRole),
    isRevenueHead: roles.some((r) => r.name === "Revenue Head"),
    roles,
  };
};

const toWorkspace = (d) => ({
  id: String(d._id),
  key: d.slug || slugify(d.name),
  name: d.name,
});

// GET /me/workspaces → { workspaces, home, last }.
const workspacesFor = async (callerId) => {
  const admin = await Admin.findById(callerId).lean();
  if (!admin) throw err(404, "Admin not found");

  await ensureSeedIfEmpty();

  const { isFounder, isRevenueHead } = await callerRoleFacts(admin);

  let departments;
  if (isFounder || isRevenueHead) {
    departments = await Department.find({ deletedAt: null }).sort({ name: 1 }).lean();
  } else {
    // The caller's hat departments (primary departmentId + every hats[] entry).
    const deptIds = [
      ...new Set(
        [admin.departmentId, ...(admin.hats || []).map((h) => h.departmentId)]
          .filter(Boolean)
          .map(String)
      ),
    ];
    departments = deptIds.length
      ? await Department.find({ _id: { $in: deptIds }, deletedAt: null }).sort({ name: 1 }).lean()
      : [];
  }

  const workspaces = departments.map(toWorkspace);
  const allowed = new Set(workspaces.map((w) => w.id));

  const homeId = admin.departmentId
    ? String(admin.departmentId)
    : (admin.hats || []).map((h) => h.departmentId).filter(Boolean).map(String)[0] || null;
  const home = homeId && allowed.has(homeId) ? homeId : workspaces[0]?.id || null;

  const lastId = admin.lastWorkspaceId ? String(admin.lastWorkspaceId) : null;
  const last = lastId && allowed.has(lastId) ? lastId : null;

  return { workspaces, home, last };
};

// PUT /me/workspace { id } — whitelisted $set of Admin.lastWorkspaceId, only
// to a workspace the caller may actually enter.
const setWorkspace = async (callerId, id) => {
  if (!isId(id)) throw err(400, "Pass a workspace id.");
  const { workspaces } = await workspacesFor(callerId);
  if (!workspaces.some((w) => w.id === String(id))) {
    throw err(403, "That workspace is not yours to enter.");
  }
  await Admin.updateOne({ _id: callerId }, { $set: { lastWorkspaceId: id } });
  return { ok: true, last: String(id) };
};

module.exports = {
  seedDayOneDepartments,
  ensureSeedIfEmpty,
  workspacesFor,
  setWorkspace,
  slugify,
};

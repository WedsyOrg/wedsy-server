// W1 — WORKSPACES test. Run: node tests/workspace-me.test.js
// Service-layer, mongoose-direct (no HTTP). Covers: idempotent day-one seed
// (keyed by slug), single-dept member sees only theirs, founder + Revenue Head
// see all, home resolution, lastWorkspaceId persist + not-yours rejection.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const WorkspaceService = require("../services/WorkspaceService");

const TAG = `wsme-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], roles: [], depts: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── Idempotent seed (keyed by slug) ──
    const first = await WorkspaceService.seedDayOneDepartments();
    const second = await WorkspaceService.seedDayOneDepartments();
    ok(first.length === 4 && second.length === 4, "seed returns the four day-one departments");
    for (const slug of ["sales", "venues", "client_servicing", "wedding_store"]) {
      const n = await Department.countDocuments({ slug, deletedAt: null });
      ok(n === 1, `exactly one active department carries slug "${slug}" after double seed`);
    }

    // ── Fixtures ──
    const deptA = await Department.create({ name: `${TAG}-DeptA`, slug: `${TAG}-a` });
    const deptB = await Department.create({ name: `${TAG}-DeptB`, slug: `${TAG}-b` });
    created.depts.push(deptA._id, deptB._id);

    const memberRole = await Role.create({ name: `${TAG}-exec`, departmentId: deptA._id, permissions: ["leads:view:own"] });
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: deptA._id, permissions: ["*:*:all"] });
    // Revenue Head detection is by role NAME — a tagged doc with that name works
    // for the caller's own roleIds and cleans up after itself.
    const rhRole = await Role.create({ name: "Revenue Head", departmentId: deptA._id, permissions: ["leads:view:team"], description: TAG });
    created.roles.push(memberRole._id, founderRole._id, rhRole._id);

    const mk = (suffix, extra = {}) =>
      Admin.create({
        name: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@x.com`, phone: `${TAG}${suffix}`,
        password: "x", roles: ["sales"], status: "active", ...extra,
      });
    const member = await mk("member", { roleId: memberRole._id, departmentId: deptA._id });
    const founder = await mk("founder", { roleId: founderRole._id, departmentId: deptA._id });
    const rh = await mk("rh", { roleId: rhRole._id, departmentId: deptA._id });
    created.admins.push(member._id, founder._id, rh._id);

    // ── Single-dept member ──
    const m = await WorkspaceService.workspacesFor(member._id);
    ok(m.workspaces.length === 1 && m.workspaces[0].id === String(deptA._id), "member sees ONLY their department");
    ok(m.workspaces[0].key === `${TAG}-a` && m.workspaces[0].name === `${TAG}-DeptA`, "workspace carries { id, key, name }");
    ok(m.home === String(deptA._id), "home = the member's department");
    ok(m.last === null, "last is null before any PUT");

    // ── Founder sees all ──
    const f = await WorkspaceService.workspacesFor(founder._id);
    const fIds = new Set(f.workspaces.map((w) => w.id));
    ok(fIds.has(String(deptA._id)) && fIds.has(String(deptB._id)), "founder (*:*:all) sees every department");

    // ── Revenue Head sees all ──
    const r = await WorkspaceService.workspacesFor(rh._id);
    const rIds = new Set(r.workspaces.map((w) => w.id));
    ok(rIds.has(String(deptA._id)) && rIds.has(String(deptB._id)), "Revenue Head sees every department");

    // ── PUT persistence (whitelisted $set) ──
    const set = await WorkspaceService.setWorkspace(member._id, String(deptA._id));
    ok(set.ok === true && set.last === String(deptA._id), "setWorkspace acks with the new last");
    const fresh = await Admin.findById(member._id, { lastWorkspaceId: 1 }).lean();
    ok(String(fresh.lastWorkspaceId) === String(deptA._id), "Admin.lastWorkspaceId persisted");
    const m2 = await WorkspaceService.workspacesFor(member._id);
    ok(m2.last === String(deptA._id), "GET reflects last after PUT");

    // ── Not-yours rejection ──
    let rejected = null;
    try { await WorkspaceService.setWorkspace(member._id, String(deptB._id)); } catch (e) { rejected = e; }
    ok(rejected && rejected.status === 403, "member cannot enter a department that isn't theirs (403)");
    const still = await Admin.findById(member._id, { lastWorkspaceId: 1 }).lean();
    ok(String(still.lastWorkspaceId) === String(deptA._id), "rejected PUT does not overwrite last");

    // ── Bad id ──
    let badId = null;
    try { await WorkspaceService.setWorkspace(member._id, "not-an-id"); } catch (e) { badId = e; }
    ok(badId && badId.status === 400, "malformed workspace id → 400");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

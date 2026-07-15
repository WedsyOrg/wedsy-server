// DEPT-SEED FIX test. Run: node tests/dept-seed-fix.test.js
// The old guard seeded only an EMPTY Departments collection — non-empty prod
// never gained Venues / Client Servicing. Covers: a NON-EMPTY collection gains
// only the missing day-one departments; an admin-created "Venues" (by name, no
// slug) is ADOPTED — slug stamped, no other field touched, never duplicated;
// second run is a no-op; founder sees all three; a single-dept member is
// unaffected.
//
// The suite snapshots the live day-one docs, removes them to stage the prod
// shape, and RESTORES them (same _ids) in finally.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const WorkspaceService = require("../services/WorkspaceService");

const TAG = `deptseed-${Date.now()}`;
const SLUGS = ["sales", "venues", "client_servicing"];
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], roles: [], depts: [] };
let snapshot = [];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── Stage the prod shape: remove the live day-one docs (snapshotted for
    //    restore), keep the collection NON-EMPTY via a TAG department. ──
    snapshot = await Department.find({ slug: { $in: SLUGS } }).lean();
    await Department.deleteMany({ _id: { $in: snapshot.map((d) => d._id) } });

    const bystander = await Department.create({ name: `${TAG}-bystander`, slug: `${TAG}-b`, description: "keep collection non-empty" });
    created.depts.push(bystander._id);
    // Admin-created "Venues" — name only, NO slug, custom description.
    const adminVenues = await Department.create({ name: "Venues", description: `${TAG} hand-made` });
    created.depts.push(adminVenues._id);

    const nonEmptyBefore = await Department.countDocuments({ deletedAt: null });
    ok(nonEmptyBefore >= 2, `collection is NON-EMPTY before the ensure (${nonEmptyBefore})`);

    // ── Run the per-department ensure ──
    await WorkspaceService.ensureDayOneDepartments();

    // Adoption: the hand-made "Venues" doc gained the slug — same _id, no dupes,
    // other fields untouched.
    const venuesDocs = await Department.find({ name: /^venues$/i, deletedAt: null }).lean();
    ok(venuesDocs.length === 1, "no duplicate Venues department");
    ok(String(venuesDocs[0]._id) === String(adminVenues._id), "existing Venues ADOPTED (same _id)");
    ok(venuesDocs[0].slug === "venues", "adopted doc got the slug stamped");
    ok(venuesDocs[0].description === `${TAG} hand-made`, "adoption touched NO other field (description intact)");
    ok(venuesDocs[0].isSystem === false, "adoption touched NO other field (isSystem intact)");

    // Creation: only the truly missing two were created.
    for (const slug of SLUGS) {
      const n = await Department.countDocuments({ slug, deletedAt: null });
      ok(n === 1, `exactly one "${slug}" after ensure`);
    }
    const sales = await Department.findOne({ slug: "sales", deletedAt: null }).lean();
    ok(sales && sales.isSystem === true, "missing departments are created as isSystem");

    // Bystander untouched.
    const by = await Department.findById(bystander._id).lean();
    ok(by && by.slug === `${TAG}-b` && by.description === "keep collection non-empty", "unrelated departments untouched");

    // ── Second run is a no-op ──
    const before = await Department.find({ deletedAt: null }).lean();
    await WorkspaceService.ensureDayOneDepartments();
    const after = await Department.find({ deletedAt: null }).lean();
    ok(after.length === before.length, "second run creates nothing");
    const changed = after.filter((a) => {
      const b = before.find((x) => String(x._id) === String(a._id));
      return !b || String(b.updatedAt) !== String(a.updatedAt);
    });
    ok(changed.length === 0, "second run modifies nothing (updatedAt stable)");

    // ── Founder sees all three day-one workspaces; member unaffected ──
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: bystander._id, permissions: ["*:*:all"] });
    const memberRole = await Role.create({ name: `${TAG}-member`, departmentId: bystander._id, permissions: ["leads:view:own"] });
    created.roles.push(founderRole._id, memberRole._id);
    const founder = await Admin.create({ name: `${TAG}-founder`, email: `${TAG}-f@x.com`, phone: `${TAG}f`, password: "x", roles: ["sales"], status: "active", roleId: founderRole._id, departmentId: bystander._id });
    const member = await Admin.create({ name: `${TAG}-member`, email: `${TAG}-m@x.com`, phone: `${TAG}m`, password: "x", roles: ["sales"], status: "active", roleId: memberRole._id, departmentId: bystander._id });
    created.admins.push(founder._id, member._id);

    const f = await WorkspaceService.workspacesFor(founder._id);
    const fKeys = new Set(f.workspaces.map((w) => w.key));
    ok(SLUGS.every((s) => fKeys.has(s)), "founder listing returns ALL departments incl the three day-one keys");
    const m = await WorkspaceService.workspacesFor(member._id);
    ok(m.workspaces.length === 1 && m.workspaces[0].id === String(bystander._id), "single-dept member still sees only their department");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    // Remove everything this suite created (incl. seed-created day-one docs)…
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await Department.deleteMany({ slug: { $in: SLUGS } }).catch(() => {});
    // …then RESTORE the snapshotted originals with their original _ids.
    if (snapshot.length) await Department.insertMany(snapshot).catch((e) => console.error("RESTORE FAILED:", e));
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

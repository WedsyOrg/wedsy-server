// AUTO-ASSIGN EXCLUSIONS test. Run: node tests/auto-assign-exclusions.test.js
// Covers: an excluded member never receives round-robin, a disabled member
// never receives (regression), the empty-pool fallback (with warning), the
// settings validation, and the pool-read shape.
// Mutates the GLOBAL assignment settings — snapshots + restores them in
// finally (the established rig pattern).
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const SettingsService = require("../services/SettingsService");
const LeadAssignmentService = require("../services/LeadAssignmentService");

const TAG = `autoexcl-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], roles: [], depts: [] };
const SETTING_KEYS = ["assignment.poolRoles", "assignment.overflowRoles", "assignment.excludedAdminIds"];
let saved = {};

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    saved = await SettingsService.getMany(SETTING_KEYS);

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const role = await Role.create({ name: `${TAG}-pool`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(role._id);
    const mk = (s, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId: role._id, ...extra });
    // A is the LEAST recently assigned (oldest) → round-robin would pick A first.
    const A = await mk("A", { lastAssignedAt: new Date("2026-01-01") });
    const B = await mk("B", { lastAssignedAt: new Date("2026-02-01") });
    const C = await mk("C", { lastAssignedAt: new Date("2026-03-01") });
    const D = await mk("D", { lastAssignedAt: new Date("2026-01-15"), isDisabled: true }); // disabled regression
    created.admins.push(A._id, B._id, C._id, D._id);

    await SettingsService.set("assignment.poolRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.overflowRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.excludedAdminIds", [], null);

    // ── baseline: A (oldest) is picked; D (disabled, older than B) never ──
    const base = await LeadAssignmentService.pickAssignee();
    ok(String(base._id) === String(A._id), "baseline round-robin picks the least-recently-assigned");
    ok(String(base._id) !== String(D._id), "disabled member never receives (regression)");

    // ── exclusion: A excluded → B picked ──
    await SettingsService.set("assignment.excludedAdminIds", [String(A._id)], null);
    const afterExcl = await LeadAssignmentService.pickAssignee();
    ok(String(afterExcl._id) === String(B._id), "excluded member is skipped — the next in rotation receives");
    // repeat: still never A across multiple picks
    let sawA = false;
    for (let i = 0; i < 3; i++) {
      const p = await LeadAssignmentService.pickAssignee();
      if (String(p._id) === String(A._id)) sawA = true;
    }
    ok(!sawA, "an excluded member NEVER receives, pick after pick");

    // ── empty-pool fallback + warning ──
    await SettingsService.set("assignment.excludedAdminIds", [String(A._id), String(B._id), String(C._id)], null);
    let warned = "";
    const origWarn = console.warn;
    console.warn = (...args) => { warned += args.join(" "); };
    const fallback = await LeadAssignmentService.pickAssignee();
    console.warn = origWarn;
    ok(!!fallback && [String(A._id), String(B._id), String(C._id)].includes(String(fallback._id)), "an emptied pool falls back to the full assignable pool (intake never dies)");
    ok(/empties/.test(warned) && /falling back/.test(warned), "the fallback logs a warning");
    ok(String(fallback._id) !== String(D._id), "the fallback still respects the assignable predicate (disabled out)");

    // ── settings validation ──
    let bad = null;
    try { await SettingsService.set("assignment.excludedAdminIds", ["not-an-id"], null); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "malformed admin id rejected (400)");
    ok((await SettingsService.get("assignment.excludedAdminIds")).length === 3, "rejected write leaves the stored value untouched");

    // ── the pool read shape (service-composed, controller-equivalent) ──
    await SettingsService.set("assignment.excludedAdminIds", [String(A._id)], null);
    const settings = require("../controllers/settings");
    let payload = null;
    const res = { status() { return this; }, json(p) { payload = p; return this; } };
    // Founder-ish caller: reuse a role with the wildcard so the gate passes.
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    created.roles.push(founderRole._id);
    const founder = await mk("F", { roleId: founderRole._id });
    created.admins.push(founder._id);
    await settings.GetAutoAssignPool({ auth: { user_id: founder._id } }, res);
    ok(payload && Array.isArray(payload.roles) && payload.roles.includes(`${TAG}-pool`), "read: roles list");
    const rows = (payload.members || []).filter((m) => m.name.startsWith(TAG));
    // A/B/C/D are pool-role members; the founder fixture is not (different role).
    ok(rows.length === 4, `read: every POOL-role member lists incl. disabled (${rows.length})`);
    const rowA = rows.find((m) => m.adminId === String(A._id));
    const rowD = rows.find((m) => m.adminId === String(D._id));
    ok(rowA && rowA.excluded === true && rowA.isDisabled === false, "read: excluded flag set");
    ok(rowD && rowD.isDisabled === true && rowD.excluded === false, "read: disabled member flagged, not hidden");
    ok(payload.excludedAdminIds.includes(String(A._id)), "read: excludedAdminIds echoed");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    // Restore the global settings exactly as found.
    for (const k of SETTING_KEYS) {
      try { await SettingsService.set(k, saved[k], null); } catch (e) { console.error("RESTORE FAILED:", k, e.message); }
    }
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

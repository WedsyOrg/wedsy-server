/* Meta app-review reviewer account for os.wedsy.in.
 *
 * Meta's reviewers must log in and verify instagram_business_basic: the
 * connected-account panel and the Connect flow both sit behind CheckAdminLogin,
 * so without a working login they cannot see the permission do anything and
 * will reject it.
 *
 * WHAT THIS SEEDS
 *   1. Role "Review Auditor" — exactly two permissions:
 *        leads:view:own      read the inbox and the Sales surface, OWN scope
 *        access:readonly:all the marker middlewares/enforceReadOnly.js keys on
 *   2. The admin meta-review@wedsy.in, carrying that role.
 *
 * Demo leads and conversations are seeded SEPARATELY (the next script). Until
 * that runs the reviewer's inbox is empty — safe and honest, just not yet
 * illustrative.
 *
 * WHY "own" SCOPE, AND WHY IT IS THE PRIVACY MECHANISM.
 * WAConversationService.listInbox intersects the caller's scope filter with the
 * conversation's linked lead, so `leads:view:own` resolves to
 * { assignedTo: <this admin> }. Nothing is assigned to this account, so it sees
 * nothing — and once the demo data lands it will see exactly that and no more.
 * Real client conversations are invisible by construction rather than by a
 * redaction layer, which is the whole reason this shape was chosen.
 *
 * THE ACCOUNT IS SAFE THE MOMENT IT EXISTS, which is the point of seeding it
 * before the demo data rather than after. It carries access:readonly:all, so
 * middlewares/enforceReadOnly.js refuses every write it attempts — including
 * the 100 delete routes that carry no permission to gate against, and including
 * POST /instagram-agent/disconnect. Do not run this script against an
 * environment that does not yet have that guard deployed.
 *
 * THE PASSWORD IS NEVER STORED, PRINTED TO A FILE, OR COMMITTED. It is
 * generated here and echoed ONCE to stdout for a human to copy into Meta's
 * review form. Re-running with --reset-password mints a new one.
 *
 * Usage:
 *   node scripts/seed-meta-reviewer.js                  # dry run
 *   node scripts/seed-meta-reviewer.js --confirm        # create/update
 *   node scripts/seed-meta-reviewer.js --confirm --reset-password
 */
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");

const CONFIRM = process.argv.includes("--confirm");
const RESET_PASSWORD = process.argv.includes("--reset-password");

const ROLE_NAME = "Review Auditor";
const ROLE_PERMISSIONS = ["leads:view:own", "access:readonly:all"];
const DEPARTMENT_NAME = "Sales";
const EMAIL = "meta-review@wedsy.in";
const DISPLAY_NAME = "Meta App Review";

const line = (s = "") => console.log(s);

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }

  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  line(`[seed] connected to ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}`);
  line(`[seed] mode: ${CONFIRM ? "APPLY" : "DRY RUN (pass --confirm to apply)"}`);
  line();

  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const { CreateHash } = require("../utils/password");

  let password = null;

  try {
    // ── 1. Department ───────────────────────────────────────────────────────
    const department = await Department.findOne({ name: DEPARTMENT_NAME, deletedAt: null }).lean();
    if (!department) {
      console.error(`[seed] department "${DEPARTMENT_NAME}" not found — run the RBAC role seed first.`);
      process.exitCode = 1;
      return;
    }
    line(`[seed] department: ${DEPARTMENT_NAME} (${department._id})`);

    // ── 2. Role ─────────────────────────────────────────────────────────────
    let role = await Role.findOne({ name: ROLE_NAME, deletedAt: null });
    if (role) {
      const missing = ROLE_PERMISSIONS.filter((p) => !(role.permissions || []).includes(p));
      line(`[seed] role "${ROLE_NAME}" exists${missing.length ? ` — missing: ${missing.join(", ")}` : " with the right permissions"}`);
      if (missing.length && CONFIRM) {
        role.permissions = [...new Set([...(role.permissions || []), ...ROLE_PERMISSIONS])];
        await role.save();
        line(`[seed]   + granted ${missing.join(", ")}`);
      }
    } else {
      line(`[seed] role "${ROLE_NAME}" will be CREATED with: ${ROLE_PERMISSIONS.join(", ")}`);
      if (CONFIRM) {
        role = await Role.create({
          name: ROLE_NAME,
          departmentId: department._id,
          description:
            "Meta app-review auditor. Read-only across the product; sees only leads assigned to it.",
          permissions: ROLE_PERMISSIONS,
          isSystem: false,
        });
        line(`[seed]   created (${role._id})`);
      }
    }

    // ── 3. Admin ────────────────────────────────────────────────────────────
    let admin = await Admin.findOne({ email: EMAIL });
    const needsPassword = !admin || RESET_PASSWORD;
    if (needsPassword) {
      // 24 bytes base64url ≈ 32 chars. No ambiguous-character policy: a reviewer
      // copy-pastes this, never retypes it.
      password = crypto.randomBytes(24).toString("base64url");
    }

    if (admin) {
      line(`[seed] admin ${EMAIL} exists (${admin._id})`);
      if (CONFIRM && role) {
        const update = {
          roleId: role._id,
          roleIds: [role._id],
          departmentId: department._id,
          status: "active",
          isDisabled: false,
          // NEVER force a reset: a reviewer cannot complete one, and Meta's
          // login would dead-end on the frontend gate.
          mustResetPassword: false,
        };
        if (RESET_PASSWORD) update.password = await CreateHash(password);
        await Admin.updateOne({ _id: admin._id }, { $set: update });
        admin = await Admin.findById(admin._id);
        line(`[seed]   updated role/department/status${RESET_PASSWORD ? " + NEW PASSWORD" : ""}`);
      }
    } else {
      line(`[seed] admin ${EMAIL} will be CREATED`);
      if (CONFIRM) {
        admin = await Admin.create({
          name: DISPLAY_NAME,
          email: EMAIL,
          phone: "PENDING",
          password: await CreateHash(password),
          roles: ["sales"], // legacy roles[] — the RBAC role above is what governs
          roleId: role._id,
          roleIds: [role._id],
          departmentId: department._id,
          status: "active",
          isDisabled: false,
          mustResetPassword: false,
          joinedAt: new Date(),
        });
        line(`[seed]   created (${admin._id})`);
      }
    }

    // Demo data is DELIBERATELY NOT SEEDED HERE — it is the next PR. This
    // script's job is the account and its guards; a reviewer logging in now
    // sees an empty inbox, which is safe and honest. Seeding demo threads is a
    // privacy improvement (it is what keeps real client conversations out of
    // view) and follows separately.
    if (!CONFIRM) {
      line();
      line("[seed] DRY RUN — nothing written. Re-run with --confirm.");
      return;
    }

    // ── 5. The one-time password echo ───────────────────────────────────────
    line();
    line("═".repeat(66));
    line("  REVIEWER ACCOUNT READY");
    line("═".repeat(66));
    line(`  Login URL : ${process.env.OS_FRONTEND_URL || "https://os.wedsy.in"}/login`);
    line(`  Email     : ${EMAIL}`);
    if (password) {
      line(`  Password  : ${password}`);
      line();
      line("  ^ Shown ONCE. Not stored, not logged, not committed anywhere.");
      line("    Copy it into Meta's review form now. To mint a new one:");
      line("    node scripts/seed-meta-reviewer.js --confirm --reset-password");
    } else {
      line("  Password  : unchanged (pass --reset-password to mint a new one)");
    }
    line("═".repeat(66));
  } catch (error) {
    console.error("[seed] FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

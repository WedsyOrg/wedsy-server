/* Settings Suite one-time idempotent seed (LOCAL DEV — also a prod deploy-checklist
 * item, run once there by a human):
 *   1. Stamp the founder role (permissions contain *:*:all) with
 *      systemKey:"founder" + protected:true — server-enforced immutability.
 *   2. Stamp system stages (new|contacted|meeting_scheduled|won|lost) with
 *      systemKey = slug (gate logic references systemKey ≡ slug; renames are safe).
 *   3. Grant CRM Admin the new settings_* permissions (it previously held
 *      settings:*:all — same intent under the new per-category resources).
 *   4. Seed the first custom field def: location ("Location / Service Area", text).
 * Run: node scripts/settings-suite-seed.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Role = require("../models/Role");
const Stage = require("../models/Stage");
const CustomFieldDef = require("../models/CustomFieldDef");

const SETTINGS_PERMS = [
  "settings_pipeline:edit:all",
  "settings_fields:edit:all",
  "settings_assignment:edit:all",
  "settings_sla:edit:all",
  "settings_cadence:edit:all",
  "settings_reasons:edit:all",
  "settings_integrations:edit:all",
  "settings_templates:edit:all",
];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const log = [];

  // 1. Founder stamp
  const founder = await Role.findOne({ permissions: "*:*:all", deletedAt: null });
  if (founder) {
    if (founder.systemKey !== "founder" || founder.protected !== true) {
      founder.systemKey = "founder";
      founder.protected = true;
      await founder.save();
      log.push(`stamped founder role "${founder.name}" (systemKey=founder, protected)`);
    } else {
      log.push("founder role already stamped");
    }
  } else {
    log.push("WARN: no role holds *:*:all — founder stamp skipped");
  }

  // 2. System stage stamps
  for (const slug of ["new", "contacted", "meeting_scheduled", "won", "lost"]) {
    const stage = await Stage.findOne({ slug, deletedAt: null });
    if (!stage) {
      log.push(`WARN: system stage "${slug}" not found`);
      continue;
    }
    if (stage.systemKey !== slug || stage.isSystem !== true) {
      stage.systemKey = slug;
      stage.isSystem = true;
      await stage.save();
      log.push(`stamped stage ${slug}`);
    } else {
      log.push(`stage ${slug} already stamped`);
    }
  }

  // 3. CRM Admin settings grants (NOT settings_roles — founder-only by policy)
  const crmAdmin = await Role.findOne({ name: "CRM Admin", deletedAt: null });
  if (crmAdmin) {
    const missing = SETTINGS_PERMS.filter((p) => !crmAdmin.permissions.includes(p));
    if (missing.length) {
      crmAdmin.permissions.push(...missing);
      await crmAdmin.save();
      log.push(`granted CRM Admin: ${missing.length} settings_* permissions`);
    } else {
      log.push("CRM Admin already has settings_* permissions");
    }
  } else {
    log.push("WARN: CRM Admin role not found");
  }

  // 4. First custom field def
  const loc = await CustomFieldDef.findOne({ key: "location" });
  if (!loc) {
    await CustomFieldDef.create({
      key: "location",
      label: "Location / Service Area",
      type: "text",
      showInCockpit: true,
      order: 0,
    });
    log.push("created custom field def: location");
  } else {
    log.push("custom field def location already present");
  }

  console.log(log.join("\n"));
  await mongoose.disconnect();
})();

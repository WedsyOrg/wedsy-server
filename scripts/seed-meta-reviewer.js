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
 *   3. Demo leads + Instagram conversations ASSIGNED TO that admin.
 *
 * WHY "own" SCOPE IS THE PRIVACY MECHANISM, not a limitation to work around.
 * WAConversationService.listInbox intersects the caller's scope filter with the
 * conversation's linked lead, so `leads:view:own` resolves to
 * { assignedTo: <reviewer> } and the reviewer sees EXACTLY the leads seeded
 * here — real client conversations are invisible by construction, not by a new
 * code path bolted on for this. That is the whole reason this shape was chosen
 * over redaction.
 *
 * A consequence worth knowing: an Instagram conversation with no linked lead
 * (a fresh DM before a phone number is captured) matches no scope filter at
 * all, so the demo conversations MUST be lead-linked or the inbox looks empty.
 * This script links them.
 *
 * EVERYTHING GOES THROUGH THE SERVICE LAYER. Raw collection writes skip the
 * computation the services perform (afterCreate, ownership events, conversation
 * state) and produce data that looks right in Compass and behaves wrong in the
 * product.
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

// Demo conversations. Deliberately ordinary wedding enquiries: the reviewer has
// to believe this is a working product, and invented names keep real clients
// out of it entirely.
const DEMO_THREADS = [
  {
    igsid: "demo_ig_1000000000001",
    profileName: "priya.weds",
    lead: { name: "Priya Raghavan", phone: "9000000001" },
    messages: [
      ["user", "hi! do you all do full wedding decor in bangalore?"],
      ["assistant", "Hi Priya! Yes — we handle full wedding décor across Bangalore. Is this for your own wedding?"],
      ["user", "yes mine, in feb next year. mostly looking for mandap and stage"],
      ["assistant", "Lovely. February is a beautiful time for it. Do you have a venue booked yet?"],
      ["user", "yes at a resort on kanakapura road. budget around 4 lakhs for decor"],
      ["assistant", "That works well for mandap and stage at that scale. I'll have someone from our team share a few concepts — could I take your number?"],
    ],
  },
  {
    igsid: "demo_ig_1000000000002",
    profileName: "arjun.k",
    lead: { name: "Arjun Kulkarni", phone: "9000000002" },
    messages: [
      ["user", "saw your reel, the floral backdrop one. is that available for receptions?"],
      ["assistant", "Thank you! Yes, that backdrop works beautifully for receptions. When is your event?"],
      ["user", "december 12. it's a reception for about 300 people"],
      ["assistant", "Got it — 300 guests in December. I'll check availability for the 12th and come back to you."],
    ],
  },
  {
    igsid: "demo_ig_1000000000003",
    profileName: "meghna.s",
    lead: { name: "Meghna Shetty", phone: "9000000003" },
    messages: [
      ["user", "hello, do you do haldi and mehendi setups separately or only full packages?"],
      ["assistant", "Hi Meghna! Either works — we do individual function setups as well as full packages. Which functions are you planning?"],
      ["user", "just haldi and mehendi, at home. small, maybe 80 people"],
      ["assistant", "Perfect, home setups for 80 are very doable. I'll put together a couple of options for you."],
    ],
  },
];

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
  const Enquiry = require("../models/Enquiry");
  const { CreateHash } = require("../utils/password");
  const LeadIntakeService = require("../services/LeadIntakeService");
  const LeadOwnershipService = require("../services/LeadOwnershipService");
  const WAConversationService = require("../services/WAConversationService");
  const WAConversationRepository = require("../repositories/WAConversationRepository");
  const WAAgentMessageRepository = require("../repositories/WAAgentMessageRepository");

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

    // ── 4. Demo leads + conversations ───────────────────────────────────────
    if (!CONFIRM) {
      line();
      line(`[seed] would seed ${DEMO_THREADS.length} demo Instagram conversations assigned to the reviewer.`);
      line("[seed] DRY RUN — nothing written. Re-run with --confirm.");
      return;
    }

    line();
    line("[seed] demo threads:");
    for (const thread of DEMO_THREADS) {
      // Idempotent: keyed on the demo IG id, which no real conversation uses.
      const existingConv = await WAConversationRepository.findByPhone(thread.igsid);
      if (existingConv && existingConv.enquiryId) {
        line(`  = ${thread.profileName}: already seeded`);
        continue;
      }

      // The lead, through the intake service so afterCreate() runs.
      let lead = await Enquiry.findOne({ phone: thread.lead.phone });
      if (!lead) {
        lead = await LeadIntakeService.createLead({
          name: thread.lead.name,
          phone: thread.lead.phone,
          verified: false,
          source: "instagram",
          additionalInfo: { instagramId: thread.igsid, demoSeed: true },
        });
      }

      // Ownership through the choke-point, so the assignment events are written
      // exactly as a real reassignment would write them.
      await LeadOwnershipService.reassignOwner(lead._id, admin._id, null, {
        notify: false,
        reason: "Meta app-review demo data",
        skipTargetValidation: true,
      });

      // The conversation + messages, through the same calls the live Instagram
      // path uses: recordInbound for a customer message, the message repository
      // for Kiara's replies (InstagramAgentService writes assistant turns the
      // same way). sendText is deliberately NOT used — it would call Meta.
      let conversation = null;
      for (const [role_, text] of thread.messages) {
        if (role_ === "user") {
          conversation = await WAConversationService.recordInbound(thread.igsid, text, "instagram");
        } else {
          await WAAgentMessageRepository.saveMessage(thread.igsid, "assistant", text);
        }
      }
      if (conversation) {
        await WAConversationRepository.updateFieldsById(conversation._id, {
          enquiryId: lead._id,
          profileName: thread.profileName,
          mode: "ai",
          lastMessagePreview: thread.messages[thread.messages.length - 1][1].slice(0, 120),
        });
      }
      line(`  + ${thread.profileName}: lead ${lead._id}, conversation linked`);
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

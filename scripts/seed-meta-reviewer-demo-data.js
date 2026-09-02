/* Demo Instagram conversations for the Meta app-review account.
 *
 * Step 3 of 3, and the one that is a PRIVACY improvement rather than a safety
 * requirement — which is why it follows the guards and the account rather than
 * blocking them.
 *
 * THE PROBLEM IT SOLVES. The Instagram inbox holds real client conversations:
 * names, phone numbers, wedding dates, budgets. Handing those to an external
 * reviewer exposes couples who never consented, and "the reviewer works at
 * Meta" is not a lawful basis. But a reviewer looking at an empty inbox cannot
 * verify instagram_business_basic either.
 *
 * HOW THE ISOLATION WORKS — and it is worth understanding before changing
 * anything here, because the mechanism is not in this file.
 * WAConversationService.listInbox intersects the caller's scope filter with the
 * conversation's linked lead. The reviewer holds leads:view:own, which resolves
 * to { assignedTo: <reviewer> }. So assigning these demo leads to the reviewer
 * is the ENTIRE isolation: real client conversations are invisible by
 * construction, not by a redaction layer that could fail open. Nothing in this
 * script filters anything; it just puts the demo data on the right side of a
 * filter that already exists.
 *
 * A consequence that bites: an Instagram conversation with NO linked lead (a
 * fresh DM before a phone number is captured) matches no scope filter at all
 * and would be invisible to the reviewer. So every demo thread here is
 * lead-linked, or the inbox renders empty and the seeding looks broken.
 *
 * EVERYTHING GOES THROUGH THE SERVICE LAYER. Raw collection writes skip the
 * computation the services perform — afterCreate, ownership events,
 * conversation state — and produce rows that look right in Compass and behave
 * wrong in the product. sendText is deliberately NOT used anywhere here: it
 * would place a real call to Meta and, worse, deliver a message.
 *
 * The demo people are invented. No real client appears in this file.
 *
 * Requires: the account from scripts/seed-meta-reviewer.js.
 *
 * Usage:
 *   node scripts/seed-meta-reviewer-demo-data.js            # dry run
 *   node scripts/seed-meta-reviewer-demo-data.js --confirm  # seed
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const EMAIL = "meta-review@wedsy.in";

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
  line(`[demo] connected to ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}`);
  line(`[demo] mode: ${CONFIRM ? "APPLY" : "DRY RUN (pass --confirm to apply)"}`);
  line();

  const Admin = require("../models/Admin");
  const Enquiry = require("../models/Enquiry");
  const LeadIntakeService = require("../services/LeadIntakeService");
  const LeadOwnershipService = require("../services/LeadOwnershipService");
  const WAConversationService = require("../services/WAConversationService");
  const WAConversationRepository = require("../repositories/WAConversationRepository");
  const WAAgentMessageRepository = require("../repositories/WAAgentMessageRepository");

  try {
    const admin = await Admin.findOne({ email: EMAIL }).lean();
    if (!admin) {
      console.error(`[demo] ${EMAIL} not found — run scripts/seed-meta-reviewer.js first.`);
      process.exitCode = 1;
      return;
    }
    line(`[demo] reviewer: ${EMAIL} (${admin._id})`);

    if (!CONFIRM) {
      line();
      line(`[demo] would seed ${DEMO_THREADS.length} Instagram conversations assigned to the reviewer:`);
      for (const t of DEMO_THREADS) line(`         @${t.profileName} — ${t.lead.name}, ${t.messages.length} messages`);
      line();
      line("[demo] DRY RUN — nothing written. Re-run with --confirm.");
      return;
    }

    for (const thread of DEMO_THREADS) {
      // Idempotent, keyed on the demo IG id — a namespace no real conversation uses.
      const existing = await WAConversationRepository.findByPhone(thread.igsid);
      if (existing && existing.enquiryId) {
        line(`  = @${thread.profileName}: already seeded`);
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

      // Ownership through the choke-point: this assignment is what makes the
      // thread visible to the reviewer and invisible to nobody else's scope.
      await LeadOwnershipService.reassignOwner(lead._id, admin._id, null, {
        notify: false,
        reason: "Meta app-review demo data",
        skipTargetValidation: true,
      });

      // Customer turns through recordInbound (the live IG path's own call);
      // Kiara's turns through the message repository, exactly as
      // InstagramAgentService writes an assistant reply. Never sendText.
      let conversation = null;
      for (const [role, text] of thread.messages) {
        if (role === "user") {
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
      line(`  + @${thread.profileName}: lead ${lead._id}, conversation linked`);
    }

    line();
    line("[demo] done. The reviewer now sees these threads and nothing else.");
  } catch (error) {
    console.error("[demo] FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

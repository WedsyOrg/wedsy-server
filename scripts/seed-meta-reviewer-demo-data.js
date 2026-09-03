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
 *   node scripts/seed-meta-reviewer-demo-data.js                     # dry run
 *   node scripts/seed-meta-reviewer-demo-data.js --confirm           # seed
 *   node scripts/seed-meta-reviewer-demo-data.js --remove            # dry run the reversal
 *   node scripts/seed-meta-reviewer-demo-data.js --remove --confirm  # delete what it created
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const REMOVE = process.argv.includes("--remove");
const EMAIL = "meta-review@wedsy.in";

// ── REVERSAL ────────────────────────────────────────────────────────────────
// --remove deletes exactly what --confirm created, keyed on WHAT THE SEED
// RECORDED, never on names. Two independent markers, both written by this
// script and by nothing else:
//
//   Enquiry.additionalInfo.demoSeed === true
//   Enquiry.additionalInfo.instagramId  starting "demo_ig_"
//   WAConversation.phone / WAAgentMessage.phone  starting "demo_ig_"
//
// A lead must carry BOTH Enquiry markers to be touched. Matching on a name
// like "Priya Raghavan" would be indefensible against a production database —
// a real client could share it.
//
// THE CHILD ROWS ARE THE PART THAT IS EASY TO GET WRONG. Creating these leads
// went through the real service layer, so it fired real side effects:
// LeadIntakeService.afterCreate ran auto-assignment and notifyNewLead (an
// AdminNotification to whichever real admin the round-robin picked), and
// LeadOwnershipService.reassignOwner ran on top. Deleting only the Enquiry
// would strand those rows pointing at an id that no longer resolves.
//
// So rather than guess which collections were written, this sweeps EVERY model
// that references Enquiry and reports per-collection counts. The dry run prints
// what it would delete, collection by collection, and deletes nothing.
const DEMO_IG_PREFIX = "demo_ig_";
const LEAD_MARKER = {
  "additionalInfo.demoSeed": true,
  "additionalInfo.instagramId": new RegExp("^" + DEMO_IG_PREFIX),
};

// Every model carrying a lead reference, with the field that holds it. Derived
// from `grep -rn 'ref: "Enquiry"' models/` — kept explicit so a new model that
// starts referencing leads is a visible omission here rather than a silent one.
const LEAD_CHILDREN = [
  ["Onboarding", "leadId"], ["LaneEntry", "leadId"], ["LeadTask", "leadId"],
  ["PlanSnapshot", "leadId"], ["LeadPlan", "leadId"], ["Event", "leadId"],
  ["LeadTeamMember", "leadId"], ["QuoteRequest", "leadId"], ["EscalationMark", "leadId"],
  ["LeadActivityEvent", "leadId"], ["LeadPayment", "leadId"], ["VenueLeadAssist", "enquiry"],
  ["DealDiscount", "leadId"], ["AdminNotification", "leadId"], ["LeadChatMessage", "leadId"],
  ["PaymentMilestone", "leadId"], ["CalendarEvent", "leadId"], ["Project", "leadId"],
  ["LeadStep", "leadId"], ["LeadInternalEvent", "leadId"], ["MoreOptionsRequest", "leadId"],
  ["PaymentReminder", "leadId"], ["Followup", "leadId"], ["LeadLane", "leadId"],
];

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
    // ── --remove ────────────────────────────────────────────────────────────
    if (REMOVE) {
      const Enquiry_ = require("../models/Enquiry");
      const WAConversation = require("../models/WAConversation");
      const WAAgentMessage = require("../models/WAAgentMessage");

      const leads = await Enquiry_.find(LEAD_MARKER, { _id: 1, name: 1, phone: 1, additionalInfo: 1 }).lean();
      line(`[remove] leads carrying BOTH seed markers: ${leads.length}`);
      for (const l of leads) {
        line(`           ${l._id}  ${l.name}  (${l.additionalInfo && l.additionalInfo.instagramId})`);
      }
      if (!leads.length) {
        line("[remove] nothing to remove — the markers match no rows here.");
        return;
      }
      const leadIds = leads.map((l) => l._id);

      // Count everything BEFORE deleting anything, so the dry run and the real
      // run print the same ledger and a surprise shows up before a write.
      const plan = [];
      for (const [modelName, field] of LEAD_CHILDREN) {
        let Model;
        try { Model = require(`../models/${modelName}`); } catch (_) { continue; }
        const n = await Model.countDocuments({ [field]: { $in: leadIds } });
        if (n) plan.push({ label: `${modelName}.${field}`, n, Model, filter: { [field]: { $in: leadIds } } });
      }
      const convFilter = { phone: new RegExp("^" + DEMO_IG_PREFIX) };
      const msgFilter = { phone: new RegExp("^" + DEMO_IG_PREFIX) };
      const nConv = await WAConversation.countDocuments(convFilter);
      const nMsg = await WAAgentMessage.countDocuments(msgFilter);
      if (nConv) plan.push({ label: "WAConversation.phone(demo_ig_)", n: nConv, Model: WAConversation, filter: convFilter });
      if (nMsg) plan.push({ label: "WAAgentMessage.phone(demo_ig_)", n: nMsg, Model: WAAgentMessage, filter: msgFilter });

      line();
      line("[remove] rows that would be deleted:");
      for (const p of plan) line(`           ${String(p.n).padStart(4)}  ${p.label}`);
      line(`           ${String(leads.length).padStart(4)}  Enquiry (the demo leads themselves)`);

      if (!CONFIRM) {
        line();
        line("[remove] DRY RUN — nothing deleted. Re-run with --remove --confirm.");
        return;
      }

      line();
      for (const p of plan) {
        const r = await p.Model.deleteMany(p.filter);
        line(`  - ${p.label}: ${r.deletedCount} deleted`);
      }
      const r = await Enquiry_.deleteMany({ _id: { $in: leadIds } });
      line(`  - Enquiry: ${r.deletedCount} deleted`);
      line();
      line("[remove] done.");
      return;
    }

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

      // MIRROR THE LIVE PATH EXACTLY. InstagramAgentService.receiveMessage does
      // TWO things for a customer turn: saveMessage(..., 'user', ...) to persist
      // the message, THEN recordInbound(...) to update conversation state. An
      // earlier version of this script called only recordInbound, which updates
      // the preview and counters but persists nothing — so the customer's half
      // of every thread was silently dropped and the inbox rendered Kiara
      // talking to herself. Keep both calls, in this order.
      let conversation = null;
      for (const [role, text] of thread.messages) {
        if (role === "user") {
          await WAAgentMessageRepository.saveMessage(thread.igsid, "user", text);
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

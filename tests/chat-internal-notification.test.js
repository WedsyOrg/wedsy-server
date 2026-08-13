// INTERNAL TEAM-CHAT notification test.
// Run: node tests/chat-internal-notification.test.js
//
// Covers the additive `chat_internal` path on LeadChatService.postMessage:
//   - post-qual roster: every member EXCEPT sender and mentioned users is notified
//   - the current owner is always included, even when absent from the roster
//   - a mentioned user gets chat_mention ONLY (never chat_internal) — the dedupe
//   - the sender is never notified
//   - unassigned lead        -> fallback reaches the Revenue Heads
//   - owner w/ no manager, sender IS the owner -> fallback reaches the Revenue Heads
//   - system messages        -> zero chat_internal
// Does not touch chat_mention, team_added, or the customer-chat / reassignment work.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const LeadTeamMember = require("../models/LeadTeamMember");
const AdminNotification = require("../models/AdminNotification");
const LeadChatMessage = require("../models/LeadChatMessage");
const LeadChatService = require("../services/LeadChatService");

const TAG = `chatint-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], team: [] };

const idsOf = async (leadId, type) =>
  (await AdminNotification.find({ leadId, type }).lean()).map((r) => String(r.adminId));
const setEq = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const mk = async (n, extra = {}) => {
      const a = await Admin.create({
        name: `${TAG}-${n}`, email: `${TAG}${n}@x.com`, phone: `${TAG}${n}`,
        password: "x", roles: ["sales"], status: "active", ...extra,
      });
      created.admins.push(a._id);
      return a;
    };
    const mkLead = async (n, fields = {}) => {
      const l = await Enquiry.create({
        name: `${TAG}-${n}`, phone: `${TAG}-${n}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        additionalInfo: {}, ...fields,
      });
      created.leads.push(l._id);
      return l;
    };
    const roster = async (leadId, personId) => {
      const r = await LeadTeamMember.create({ leadId, personId, activeTo: null });
      created.team.push(r._id);
      return r;
    };

    // Revenue Head role: reuse the real one if this DB already has it, otherwise
    // create it (and clean it up). Fixture RH is asserted by MEMBERSHIP, not by
    // set equality — a shared dev DB may hold other real Revenue Heads.
    let rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null }).lean();
    if (!rhRole) {
      rhRole = (await Role.create({ name: "Revenue Head", permissions: ["leads:view:all"] })).toObject();
      created.roles.push(rhRole._id);
    }
    const RH = await mk("rh", { roleId: rhRole._id });

    // ── 1. Post-qual roster: sender + mention excluded, owner unioned in ──────
    const OWNER = await mk("owner");
    const M1 = await mk("m1");
    const M2 = await mk("m2");
    const SENDER = await mk("sender");

    // Roster deliberately EXCLUDES the owner (mirrors the qualify hinge, which
    // rosters the outgoing owner and never auto-adds the incoming one).
    const lead1 = await mkLead("l1", { assignedTo: OWNER._id, qualified: true });
    await roster(lead1._id, M1._id);
    await roster(lead1._id, M2._id);
    await roster(lead1._id, SENDER._id);

    const returned = await LeadChatService.postMessage(lead1._id, SENDER._id, {
      body: "Aligning on the decor budget before the call.",
      mentions: [String(M2._id)],
    });

    const internal1 = await idsOf(lead1._id, "chat_internal");
    ok(
      setEq(internal1, [String(M1._id), String(OWNER._id)]),
      `roster message notifies exactly {M1, OWNER} (got ${internal1.length})`
    );
    ok(!internal1.includes(String(SENDER._id)), "sender is never notified");
    ok(!internal1.includes(String(M2._id)), "mentioned user gets NO chat_internal (dedupe)");
    ok(
      internal1.includes(String(OWNER._id)),
      "current owner included even though absent from the roster"
    );

    const mention1 = await idsOf(lead1._id, "chat_mention");
    ok(setEq(mention1, [String(M2._id)]), "mentioned user still gets chat_mention (unchanged)");

    const row = (await AdminNotification.find({ leadId: lead1._id, type: "chat_internal" }).lean())[0];
    ok(row.title === `${SENDER.name} messaged on ${lead1.name}`, "title names author + lead");
    ok(row.message === "Aligning on the decor budget before the call.", "message is the body (<=160)");
    ok(String(row.payload.messageId) === String(returned._id), "payload.messageId points at the message");
    ok(!!returned.authorName, "postMessage return value still enriched (unchanged)");

    // ── 2. Unassigned lead -> Revenue Head fallback ──────────────────────────
    const lead2 = await mkLead("l2", { assignedTo: null, qualified: false });
    await LeadChatService.postMessage(lead2._id, SENDER._id, { body: "Who owns this one?" });
    const internal2 = await idsOf(lead2._id, "chat_internal");
    ok(internal2.includes(String(RH._id)), "unassigned lead -> Revenue Head notified (fallback)");
    ok(!internal2.includes(String(SENDER._id)), "fallback still excludes the sender");

    // ── 3. Owner with no manager, sender IS the owner -> Revenue Head ────────
    const OWNER2 = await mk("owner2"); // reportingManagerId defaults to null
    const lead3 = await mkLead("l3", { assignedTo: OWNER2._id, qualified: false });
    await LeadChatService.postMessage(lead3._id, OWNER2._id, { body: "Noting this for the record." });
    const internal3 = await idsOf(lead3._id, "chat_internal");
    ok(internal3.includes(String(RH._id)), "owner-is-sender, no manager -> Revenue Head notified");
    ok(!internal3.includes(String(OWNER2._id)), "owner-sender not notified about their own message");
    ok(internal3.length > 0, "a real human message never produces zero notifications");

    // ── 4. Pre-qual: assignee + their reporting manager ──────────────────────
    const MGR = await mk("mgr");
    const OWNER3 = await mk("owner3", { reportingManagerId: MGR._id });
    const lead4 = await mkLead("l4", { assignedTo: OWNER3._id, qualified: false });
    await LeadChatService.postMessage(lead4._id, SENDER._id, { body: "Heads up on this lead." });
    const internal4 = await idsOf(lead4._id, "chat_internal");
    ok(
      setEq(internal4, [String(OWNER3._id), String(MGR._id)]),
      "pre-qual notifies assignee + their reporting manager (chatMembers reused)"
    );

    // ── 5. Sole participant is the MENTIONED owner -> fallback strips them ───
    // Primary set = chatMembers{OWNER4} ∪ {OWNER4}, minus sender (not present),
    // minus mentions{OWNER4} -> EMPTY, so the fallback branch runs. It re-adds
    // the owner, and the mention-strip must remove them again.
    const OWNER4 = await mk("owner4"); // no reportingManagerId
    const lead6 = await mkLead("l6", { assignedTo: OWNER4._id, qualified: false });
    await LeadChatService.postMessage(lead6._id, SENDER._id, {
      body: "Tagging you directly on this one.",
      mentions: [String(OWNER4._id)],
    });

    const internal6 = await idsOf(lead6._id, "chat_internal");
    const mention6 = await idsOf(lead6._id, "chat_mention");
    ok(setEq(mention6, [String(OWNER4._id)]), "mentioned sole participant gets chat_mention");
    ok(
      !internal6.includes(String(OWNER4._id)),
      "mentioned sole participant gets ZERO chat_internal (fallback strips mentions too)"
    );
    ok(!internal6.includes(String(SENDER._id)), "fallback still excludes the sender");

    // ── 6. System messages -> zero chat_internal ─────────────────────────────
    const lead5 = await mkLead("l5", { assignedTo: OWNER._id, qualified: false });
    await LeadChatService.postSystemMessage(lead5._id, {
      body: "Task created: call the couple", systemType: "task_created",
    });
    const internal5 = await idsOf(lead5._id, "chat_internal");
    ok(internal5.length === 0, "system message writes NO chat_internal");
    ok(
      (await LeadChatMessage.countDocuments({ leadId: lead5._id, kind: "system" })) === 1,
      "the system message itself was still written (behaviour unchanged)"
    );

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL:", e);
    fail++;
  } finally {
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadChatMessage.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadTeamMember.deleteMany({ _id: { $in: created.team } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

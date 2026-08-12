// CHAT NOTIFICATION test. Run: node tests/chat-notification.test.js
// Covers the additive inbound-chat bell notification:
//   - inbound customer message on an OWNED lead  -> exactly one "chat" row to the owner
//   - staff (admin) / Kiara (agent) traffic      -> none (they never hit recordInbound)
//   - UNOWNED lead / unlinked conversation       -> none (no broadcast)
//   - dedupe: a second unread message same lead  -> refreshes, does not duplicate
//   - a read row does NOT absorb the next message (dedupe is unread-only)
// Also asserts the pre-existing assignment notification path is untouched.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const AdminNotification = require("../models/AdminNotification");
const WAConversation = require("../models/WAConversation");
const WAConversationRepository = require("../repositories/WAConversationRepository");
const WAConversationService = require("../services/WAConversationService");
const AdminNotificationService = require("../services/AdminNotificationService");

const TAG = `chatnotif-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], conversations: [] };

const chatRows = (adminId, leadId) =>
  AdminNotification.find({ adminId, leadId, type: "chat" }).sort({ createdAt: -1 }).lean();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}@x.com`, phone: `${TAG}o`,
      password: "x", roles: ["sales"], status: "active",
    });
    created.admins.push(owner._id);

    const mkLead = async (suffix, assignedTo) => {
      const lead = await Enquiry.create({
        name: `${TAG}-${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo,
      });
      created.leads.push(lead._id);
      return lead;
    };

    const mkConversation = async (phone, enquiryId) => {
      const c = await WAConversation.create({
        phone, normalizedPhone: phone, channel: "whatsapp",
        profileName: `${TAG}-couple`, enquiryId,
      });
      created.conversations.push(c._id);
      return c;
    };

    // ── 1. Inbound customer message on an OWNED lead ────────────────────────
    const ownedLead = await mkLead("owned", owner._id);
    const phoneOwned = `${TAG}-p1`;
    await mkConversation(phoneOwned, ownedLead._id);

    await WAConversationService.recordInbound(phoneOwned, "Hi, is the Jaipur date still open for us?");

    let rows = await chatRows(owner._id, ownedLead._id);
    ok(rows.length === 1, "inbound on owned lead -> exactly one chat notification");
    const n = rows[0];
    ok(n && String(n.adminId) === String(owner._id), "recipient is the lead owner");
    ok(n && n.type === "chat", 'type is "chat"');
    ok(n && n.read === false, "created unread");
    ok(n && n.payload && String(n.payload.leadId) === String(ownedLead._id), "payload.leadId set");
    ok(n && n.payload && !!n.payload.chatId, "payload.chatId set (conversation id)");
    ok(n && n.payload && n.payload.from === `${TAG}-couple`, "payload.from is the profile name");
    ok(
      n && n.payload && n.payload.preview === "Hi, is the Jaipur date still open for us?".slice(0, 60),
      "payload.preview is the first ~60 chars"
    );
    ok(n && n.payload.preview.length <= 60, "preview capped at 60 chars");

    // ── 2. Dedupe: a second unread message refreshes, does not duplicate ─────
    const firstId = String(n._id);
    const firstUpdatedAt = new Date(n.updatedAt).getTime();

    // A LATER, untouched notification on a different lead. The refreshed chat
    // row must out-sort it — that is the whole point of the updatedAt sort, and
    // it would fail under the old createdAt sort.
    await new Promise((r) => setTimeout(r, 5));
    const otherLead = await mkLead("other", owner._id);
    await AdminNotificationService.notify(owner._id, {
      type: "new_lead", title: `${TAG}-other`, leadId: otherLead._id,
    });

    await new Promise((r) => setTimeout(r, 5)); // guard against a same-ms false-equal
    await WAConversationService.recordInbound(phoneOwned, "Also — can you send the decor options?");

    rows = await chatRows(owner._id, ownedLead._id);
    ok(rows.length === 1, "second unread message -> still ONE row (deduped)");
    ok(rows.length === 1 && String(rows[0]._id) === firstId, "deduped onto the SAME row id");
    ok(
      rows.length === 1 && rows[0].payload.preview === "Also — can you send the decor options?",
      "deduped row carries the LATEST preview"
    );
    ok(
      rows.length === 1 && new Date(rows[0].updatedAt).getTime() > firstUpdatedAt,
      "deduped row updatedAt bumped"
    );
    const bell = await AdminNotificationService.listMine(owner._id, { limit: 10 });
    ok(
      bell.length >= 2 && String(bell[0]._id) === firstId,
      "refreshed row sorts FIRST in listMine, ahead of a newer untouched row"
    );

    // ── 3. Dedupe is UNREAD-only: a read row does not absorb the next message ─
    await AdminNotification.updateOne({ _id: firstId }, { $set: { read: true } });
    await WAConversationService.recordInbound(phoneOwned, "Following up on the above.");
    rows = await chatRows(owner._id, ownedLead._id);
    ok(rows.length === 2, "after the row is read, the next message creates a NEW row");
    ok(rows.filter((r) => r.read === false).length === 1, "exactly one unread chat row remains");

    // ── 4. Staff (admin) and Kiara (agent) traffic -> no notification ────────
    // Both route through touchOutbound, never recordInbound. Assert structurally.
    const beforeOutbound = (await chatRows(owner._id, ownedLead._id)).length;
    const conv = await WAConversation.findOne({ phone: phoneOwned });
    await WAConversationRepository.touchOutbound(conv._id, "Staff reply from the CRM");
    await WAConversationRepository.touchOutbound(conv._id, "Kiara's auto-reply");
    const afterOutbound = (await chatRows(owner._id, ownedLead._id)).length;
    ok(afterOutbound === beforeOutbound, "staff + agent outbound messages create NO chat notification");

    // ── 5. UNOWNED lead -> no notification, no broadcast ─────────────────────
    const unownedLead = await mkLead("unowned", null);
    const phoneUnowned = `${TAG}-p2`;
    await mkConversation(phoneUnowned, unownedLead._id);
    await WAConversationService.recordInbound(phoneUnowned, "Hello? Anyone there?");

    const unownedRows = await AdminNotification.find({ leadId: unownedLead._id, type: "chat" }).lean();
    ok(unownedRows.length === 0, "unassigned lead -> no chat notification at all");

    // ── 6. Conversation with no linked lead -> no notification ───────────────
    const phoneUnlinked = `${TAG}-p3`;
    await WAConversationService.recordInbound(phoneUnlinked, "First ever message, no lead yet");
    const unlinkedConv = await WAConversation.findOne({ phone: phoneUnlinked });
    if (unlinkedConv) created.conversations.push(unlinkedConv._id);
    const unlinkedRows = await AdminNotification.find({ type: "chat", "payload.chatId": String(unlinkedConv._id) }).lean();
    ok(unlinkedRows.length === 0, "conversation with no enquiryId -> no chat notification");

    // ── 7. The inbound write itself is unchanged (additive only) ─────────────
    ok(
      unlinkedConv && unlinkedConv.unreadCount === 1 && unlinkedConv.lastMessagePreview.startsWith("First ever message"),
      "recordInbound still upserts the conversation exactly as before"
    );
    const refetched = await WAConversation.findOne({ phone: phoneOwned }).lean();
    ok(refetched && refetched.unreadCount === 3, "inbound unread counter still increments per message");

    // ── 8. Existing notification behaviour untouched ─────────────────────────
    const nonChat = await AdminNotification.find({ leadId: ownedLead._id, type: { $ne: "chat" } }).lean();
    ok(nonChat.length === 0, "no stray non-chat notifications written by this path");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL:", e);
    fail++;
  } finally {
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await WAConversation.deleteMany({ _id: { $in: created.conversations } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

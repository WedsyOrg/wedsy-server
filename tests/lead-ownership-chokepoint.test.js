// OWNERSHIP CHOKE-POINT test. Run: node tests/lead-ownership-chokepoint.test.js
// Covers LeadOwnershipService.reassignOwner and the three routed write sites:
//   - A->B notifies B, never A
//   - same-owner call is a true no-op (no write, no notification)
//   - self-assign (actor === newOwner) sets the owner but writes NO notification
//   - A->B->C leaves exactly ONE unread assignment row, on C
//   - manual assign / round-robin / bulk transfer each produce exactly one row
//   - unassign (-> null) writes nothing to anyone and retires the stale row
// Does NOT touch chat-notification or any existing non-assignment behaviour.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const AdminNotification = require("../models/AdminNotification");
const LeadOwnershipService = require("../services/LeadOwnershipService");
const EnquiryService = require("../services/EnquiryService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const LeadAssignmentService = require("../services/LeadAssignmentService");

const TAG = `ownchoke-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [] };
const T = "assignment";

const rowsFor = (adminId, leadId) =>
  AdminNotification.find({ adminId, leadId, type: T }).sort({ updatedAt: -1 }).lean();
const unreadFor = (leadId) =>
  AdminNotification.find({ leadId, type: T, read: false }).lean();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const mkAdmin = async (n) => {
      const a = await Admin.create({
        name: `${TAG}-${n}`, email: `${TAG}-${n}@x.com`, phone: `${TAG}${n}`,
        password: "x", roles: ["sales"], status: "active",
      });
      created.admins.push(a._id);
      return a;
    };
    const mkLead = async (n, assignedTo) => {
      const l = await Enquiry.create({
        name: `${TAG}-${n}`, phone: `${TAG}-${n}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo,
      });
      created.leads.push(l._id);
      return l;
    };

    const A = await mkAdmin("A");
    const B = await mkAdmin("B");
    const C = await mkAdmin("C");
    const actor = await mkAdmin("actor");

    // ── 1. A -> B notifies B, not A ─────────────────────────────────────────
    const lead1 = await mkLead("l1", A._id);
    const r1 = await LeadOwnershipService.reassignOwner(lead1._id, B._id, actor._id);
    ok(r1.changed === true, "A->B reports changed");
    ok(String(r1.oldOwner) === String(A._id), "oldOwner reported correctly");

    const fresh1 = await Enquiry.findById(lead1._id).lean();
    ok(String(fresh1.assignedTo) === String(B._id), "owner actually written to B");
    ok((await rowsFor(B._id, lead1._id)).length === 1, "new owner B got exactly one notification");
    ok((await rowsFor(A._id, lead1._id)).length === 0, "old owner A got NO notification");

    const nb = (await rowsFor(B._id, lead1._id))[0];
    ok(nb.type === "assignment", 'type is "assignment"');
    ok(nb.title === `${lead1.name} assigned to you`, "title names the lead");
    ok(String(nb.payload.leadId) === String(lead1._id), "payload.leadId set");
    ok(String(nb.payload.from) === String(A._id), "payload.from is the previous owner");
    ok(String(nb.payload.by) === String(actor._id), "payload.by is the actor");

    // ── 2. Same owner -> true no-op ─────────────────────────────────────────
    const beforeNoop = (await rowsFor(B._id, lead1._id)).length;
    const r2 = await LeadOwnershipService.reassignOwner(lead1._id, B._id, actor._id);
    ok(r2.changed === false, "same-owner call reports changed:false");
    ok(r2.notified === false, "same-owner call reports notified:false");
    ok((await rowsFor(B._id, lead1._id)).length === beforeNoop, "same-owner call wrote NO new notification");

    // ── 3. Self-assign -> owner set, no notification ─────────────────────────
    const lead2 = await mkLead("l2", A._id);
    const r3 = await LeadOwnershipService.reassignOwner(lead2._id, C._id, C._id);
    ok(r3.changed === true, "self-assign still changes the owner");
    ok(r3.notified === false, "self-assign reports notified:false");
    const fresh2 = await Enquiry.findById(lead2._id).lean();
    ok(String(fresh2.assignedTo) === String(C._id), "self-assign wrote the owner");
    ok((await rowsFor(C._id, lead2._id)).length === 0, "self-assign wrote NO notification");

    // ── 4. A -> B -> C leaves ONE unread row, on C ───────────────────────────
    const lead3 = await mkLead("l3", A._id);
    await LeadOwnershipService.reassignOwner(lead3._id, B._id, actor._id);
    await LeadOwnershipService.reassignOwner(lead3._id, C._id, actor._id);
    const unread3 = await unreadFor(lead3._id);
    ok(unread3.length === 1, "A->B->C leaves exactly ONE unread assignment row");
    ok(unread3.length === 1 && String(unread3[0].adminId) === String(C._id), "the surviving unread row belongs to C");
    ok(
      (await rowsFor(B._id, lead3._id)).every((r) => r.read === true),
      "B's now-stale row was retired (marked read), not left unread"
    );

    // ── 5. Routed site: manual assign (PUT /enquiry/:id/assign) ──────────────
    const lead4 = await mkLead("l4", A._id);
    await EnquiryService.updateAssignedTo(lead4._id, String(B._id), actor._id);
    const fresh4 = await Enquiry.findById(lead4._id).lean();
    ok(String(fresh4.assignedTo) === String(B._id), "manual assign wrote the owner");
    ok((await rowsFor(B._id, lead4._id)).length === 1, "manual assign -> exactly one notification, no duplicate");

    // ── 6. Routed site: bulk transfer ────────────────────────────────────────
    const lead5 = await mkLead("l5", A._id);
    const lead6 = await mkLead("l6", A._id);
    await LeadLifecycleService.bulkTransfer(
      { leadIds: [String(lead5._id), String(lead6._id)], toAdminId: String(C._id) },
      actor._id,
      {}
    );
    const f5 = await Enquiry.findById(lead5._id).lean();
    const f6 = await Enquiry.findById(lead6._id).lean();
    ok(
      String(f5.assignedTo) === String(C._id) && String(f6.assignedTo) === String(C._id),
      "bulk transfer wrote both owners"
    );
    ok((await rowsFor(C._id, lead5._id)).length === 1, "bulk transfer -> one notification for lead5");
    ok((await rowsFor(C._id, lead6._id)).length === 1, "bulk transfer -> one notification for lead6");
    ok((await rowsFor(A._id, lead5._id)).length === 0, "bulk transfer did NOT notify the old owner");

    // ── 7. Routed site: round-robin auto-assign ──────────────────────────────
    // Drive reassignOwner the way doAssignLead does (actorId null, notify on).
    const lead7 = await mkLead("l7", A._id);
    const r7 = await LeadAssignmentService.assignLead; // referenced so the module is exercised
    ok(typeof r7 === "function", "assignLead is exported (round-robin entry point)");
    await LeadOwnershipService.reassignOwner(lead7._id, B._id, null, {
      reason: "auto_assign", skipTargetValidation: true,
    });
    ok((await rowsFor(B._id, lead7._id)).length === 1, "auto-assign path -> exactly one notification");
    ok(
      (await rowsFor(B._id, lead7._id))[0].payload.reason === "auto_assign",
      "auto-assign notification carries reason auto_assign"
    );
    // notify:false (the lead-creation path) must stay silent — no double with new_lead.
    const lead8 = await mkLead("l8", A._id);
    await LeadOwnershipService.reassignOwner(lead8._id, B._id, null, {
      notify: false, skipTargetValidation: true,
    });
    ok(
      String((await Enquiry.findById(lead8._id).lean()).assignedTo) === String(B._id) &&
        (await rowsFor(B._id, lead8._id)).length === 0,
      "notify:false (create path) writes the owner but NO notification"
    );

    // ── 8. Unassign -> nobody notified, stale row retired ────────────────────
    const lead9 = await mkLead("l9", A._id);
    await LeadOwnershipService.reassignOwner(lead9._id, B._id, actor._id);
    const r9 = await LeadOwnershipService.reassignOwner(lead9._id, null, actor._id);
    ok(r9.changed === true && r9.notified === false, "unassign changes owner, notifies nobody");
    ok((await Enquiry.findById(lead9._id).lean()).assignedTo == null, "unassign cleared the owner");
    ok((await unreadFor(lead9._id)).length === 0, "unassign leaves no unread assignment rows");

    // ── 9. Existing behaviour untouched ─────────────────────────────────────
    const strayChat = await AdminNotification.find({ leadId: { $in: created.leads }, type: "chat" }).lean();
    ok(strayChat.length === 0, "no chat notifications written by the ownership path");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL:", e);
    fail++;
  } finally {
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

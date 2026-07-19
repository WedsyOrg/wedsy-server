// L4 — QUOTE-REQUEST QUEUE test. Run: node tests/quote-requests.test.js
// Covers: ingest (leadId + userId bridge + unresolvable-user fallback), the
// side effects (owner notification, decor-lane auto entry, quote_sent activity
// event), lead + workspace reads, and the whitelisted status PATCH.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const User = require("../models/User");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const AdminNotification = require("../models/AdminNotification");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const QuoteRequest = require("../models/QuoteRequest");
const QuoteRequestService = require("../services/QuoteRequestService");

const TAG = `quotereq-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], users: [], lanes: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}@x.com`, phone: `${TAG}o`, password: "x", roles: ["sales"], status: "active" });
    const pricer = await Admin.create({ name: `${TAG}-pricer`, email: `${TAG}p@x.com`, phone: `${TAG}p`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(owner._id, pricer._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: owner._id,
    });
    created.leads.push(lead._id);
    const lane = await LeadLane.create({ leadId: lead._id, key: "decor", name: "Decor", state: "active", ownerId: owner._id });
    created.lanes.push(lane._id);
    const couple = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-ph` });
    const ghost = await User.create({ name: `${TAG}-ghost`, phone: `${TAG}-nomatch` });
    created.users.push(couple._id, ghost._id);

    // ── ingest with leadId ──
    const r1 = await QuoteRequestService.ingest({
      leadId: lead._id, draftName: "Sangeet dream", itemCount: 7,
      payload: { items: [{ id: "d1" }, { id: "d2" }] },
    });
    ok(r1.status === "pending" && String(r1.leadId) === String(lead._id), "ingest creates a pending request on the lead");
    ok(r1.itemCount === 7 && r1.payload.items.length === 2, "payload + itemCount kept verbatim");
    const notif = await AdminNotification.find({ leadId: lead._id, type: "quote_request" }).lean();
    ok(notif.length === 1 && String(notif[0].adminId) === String(owner._id), "lead owner gets the needs-attention notification");
    const entry = await LaneEntry.findOne({ laneId: lane._id, kind: "auto" }).lean();
    ok(!!entry && /Quote request — Sangeet dream \(7 items\)/.test(entry.text), `decor-lane auto entry ("${entry && entry.text}")`);
    const act = await LeadActivityEvent.findOne({ leadId: lead._id, kind: "quote_sent" }).lean();
    ok(!!act && act.voice === "couple" && /Sangeet dream/.test(act.text), "quote_sent activity event echoed (couple voice)");

    // ── ingest via userId phone-bridge ──
    const r2 = await QuoteRequestService.ingest({ userId: couple._id, draftName: "Haldi looks", itemCount: 3 });
    ok(String(r2.leadId) === String(lead._id) && String(r2.userId) === String(couple._id), "userId resolves the lead via the phone bridge");

    // ── unresolvable user still queues (leadId null) ──
    const r3 = await QuoteRequestService.ingest({ userId: ghost._id, draftName: "Mystery", itemCount: 1 });
    ok(r3.leadId === null && String(r3.userId) === String(ghost._id), "no matching lead → queued with leadId null");

    // ── reads ──
    const forLead = await QuoteRequestService.listForLead(lead._id, {});
    ok(forLead.list.length === 2, "lead read carries its two requests");
    const queue = await QuoteRequestService.listQueue({ status: "pending" });
    const mine = queue.list.filter((r) => (r.draftName || "").length && [String(r1._id), String(r2._id), String(r3._id)].includes(String(r._id)));
    ok(mine.length === 3, "workspace queue carries all three (incl. the lead-less one)");
    ok(mine.find((r) => String(r._id) === String(r1._id)).leadName === `${TAG}-lead`, "queue rows resolve leadName");

    // ── PATCH status ──
    const priced = await QuoteRequestService.patchStatus(r1._id, "priced", pricer._id);
    ok(priced.status === "priced" && String(priced.pricedBy) === String(pricer._id) && !!priced.pricedAt, "priced stamps pricedBy/pricedAt");
    const dismissed = await QuoteRequestService.patchStatus(r3._id, "dismissed", pricer._id);
    ok(dismissed.status === "dismissed" && !dismissed.pricedBy, "dismissed does not stamp pricing");
    let bad = null;
    try { await QuoteRequestService.patchStatus(r1._id, "lost", pricer._id); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "unknown status → 400");
    const pendingOnly = await QuoteRequestService.listQueue({ status: "pending" });
    ok(!pendingOnly.list.some((r) => String(r._id) === String(r1._id)), "priced requests leave the pending queue");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await QuoteRequest.deleteMany({ $or: [{ leadId: { $in: created.leads } }, { userId: { $in: created.users } }] }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

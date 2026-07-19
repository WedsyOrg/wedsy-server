// L1 — LEAD ACTIVITY test. Run: node tests/lead-activity.test.js
// Covers: ingest by leadId + by userId (phone bridge), auto-composed text,
// voice defaults, newest-first + voice-filtered list, warmth (hot/quiet),
// presence tones (green/gray/amber), the LeadPayment producer (voice by mode),
// and milestone-tag validation on record().
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const User = require("../models/User");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadPayment = require("../models/LeadPayment");
const PaymentMilestone = require("../models/PaymentMilestone");
const LeadActivityService = require("../services/LeadActivityService");
const LeadPaymentService = require("../services/LeadPaymentService");

const TAG = `leadact-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], users: [], milestones: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id, ...extra,
      });
    const L1 = await mkLead("hot");
    const L2 = await mkLead("quiet");
    const L3 = await mkLead("amber");
    created.leads.push(L1._id, L2._id, L3._id);
    const coupleUser = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-hot` }); // phone matches L1
    const quietUser = await User.create({ name: `${TAG}-ghost`, phone: `${TAG}-quiet` }); // matches L2
    created.users.push(coupleUser._id, quietUser._id);

    // ── ingest: by leadId, auto-text, voice default ──
    const e1 = await LeadActivityService.ingest({ leadId: L1._id, kind: "heart", meta: { itemName: "Mandap A" } });
    ok(e1.text === "Hearted “Mandap A”", `auto-composed text ("${e1.text}")`);
    ok(e1.voice === "wedsy", "no couple identity → voice defaults to wedsy");
    // by userId → phone bridge; couple voice default
    const e2 = await LeadActivityService.ingest({ userId: coupleUser._id, kind: "login" });
    ok(String(e2.leadId) === String(L1._id), "userId resolves the lead via the phone bridge");
    ok(e2.voice === "couple" && e2.text === "Opened the app", "couple identity → couple voice + login text");
    // explicit text wins
    const e3 = await LeadActivityService.ingest({ leadId: L1._id, kind: "other", text: "Custom line", voice: "couple" });
    ok(e3.text === "Custom line", "explicit text is kept verbatim");
    let bad = null;
    try { await LeadActivityService.ingest({ leadId: L1._id, kind: "nope" }); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "unknown kind → 400");
    bad = null;
    try { await LeadActivityService.ingest({ kind: "login" }); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "no resolvable identity → 400");

    // ── list: newest-first + voice filter ──
    await LeadActivityService.ingest({ leadId: L1._id, kind: "draft_view", meta: { draftName: "Sangeet" }, voice: "couple" });
    const all = await LeadActivityService.list(L1._id, {});
    ok(all.events.length >= 4 && +new Date(all.events[0].at) >= +new Date(all.events[all.events.length - 1].at), "list is newest-first");
    const coupleOnly = await LeadActivityService.list(L1._id, { voice: "couple" });
    ok(coupleOnly.events.every((e) => e.voice === "couple"), "voice filter works");

    // ── warmth: hot (3+ draft_view/heart in 24h) ──
    await LeadActivityService.ingest({ leadId: L1._id, kind: "heart", voice: "couple" });
    await LeadActivityService.ingest({ leadId: L1._id, kind: "draft_view", voice: "couple" });
    const w1 = await LeadActivityService.warmthFor(L1._id);
    ok(w1.warmth.hot === true, "3+ draft_view/heart couple events in 24h → hot");
    ok(w1.presence.tone === "green" && !!w1.presence.lastActiveAt, "fresh couple activity → green presence");
    ok(w1.warmth.quiet === false, "active couple is not quiet");

    // ── quiet: linked user exists, no couple events ──
    const w2 = await LeadActivityService.warmthFor(L2._id);
    ok(w2.warmth.quiet === true, "linked user + zero couple activity → quiet");
    ok(w2.presence.tone === null && w2.presence.lastActiveAt === null, "never-seen couple → null presence");

    // ── tones: gray (3d) and amber (20d) via backdated events ──
    await LeadActivityService.ingest({ leadId: L3._id, kind: "login", voice: "couple", at: new Date(+now - 3 * DAY) });
    const w3 = await LeadActivityService.warmthFor(L3._id);
    ok(w3.presence.tone === "gray", "3d-old couple activity → gray");
    await LeadActivityEvent.deleteMany({ leadId: L3._id });
    await LeadActivityService.ingest({ leadId: L3._id, kind: "login", voice: "couple", at: new Date(+now - 20 * DAY) });
    const w4 = await LeadActivityService.warmthFor(L3._id);
    ok(w4.presence.tone === "amber", "20d-old couple activity → amber");

    // ── the LeadPayment producer ──
    await LeadPaymentService.record(L1._id, { amount: 50000, mode: "bank" }, admin._id);
    const payEvents = await LeadActivityEvent.find({ leadId: L1._id, kind: "payment" }).lean();
    ok(payEvents.length === 1 && payEvents[0].voice === "wedsy", "bank payment → payment event, wedsy voice");
    ok(/₹/.test(payEvents[0].text), `payment text carries the amount ("${payEvents[0].text}")`);
    await LeadPaymentService.record(L1._id, { amount: 10000, mode: "razorpay" }, admin._id);
    const gw = await LeadActivityEvent.find({ leadId: L1._id, kind: "payment", voice: "couple" }).lean();
    ok(gw.length === 1, "razorpay (gateway) payment → couple voice");

    // ── milestone-tag validation on record ──
    const m = await PaymentMilestone.create({ leadId: L2._id, name: `${TAG} m`, amount: 1000 });
    created.milestones.push(m._id);
    bad = null;
    try { await LeadPaymentService.record(L1._id, { amount: 500, milestoneId: m._id }, admin._id); } catch (e) { bad = e; }
    ok(bad && bad.status === 404, "a milestone from another lead is rejected (404)");
    const tagged = await LeadPaymentService.record(L2._id, { amount: 500, milestoneId: m._id }, admin._id);
    ok(String(tagged.milestoneId) === String(m._id), "valid milestone tag persists on the payment");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPayment.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await PaymentMilestone.deleteMany({ _id: { $in: created.milestones } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

// P5 — DEAL DISCOUNT + LANE FEED test. Run: node tests/plan-discount-feed.test.js
// Covers: auto-approve within the free band, pending above it (+ approver
// notification + the Team approvals read gains discount_approval rows),
// decide eligibility, gross/discount/net math, and feed-decor-lane proposing
// the net décor total on the Décor lane with the auto entry.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Decor = require("../models/Decor");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const AdminNotification = require("../models/AdminNotification");
const DealDiscount = require("../models/DealDiscount");
const Event = require("../models/Event");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const DraftEventService = require("../services/DraftEventService");
const PlanSnapshotService = require("../services/PlanSnapshotService");
const TeamReadService = require("../services/TeamReadService");

const TAG = `plandisc-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], decors: [], events: [], lanes: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: new mongoose.Types.ObjectId(), permissions: ["leads:view:team", "leads:approve:all"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: new mongoose.Types.ObjectId(), permissions: ["leads:view:own"] });
    created.roles.push(mgrRole._id, icRole._id);
    const manager = await Admin.create({ name: `${TAG}-mgr`, email: `${TAG}m@x.com`, phone: `${TAG}m`, password: "x", roles: ["sales"], status: "active", roleId: mgrRole._id });
    const seller = await Admin.create({ name: `${TAG}-seller`, email: `${TAG}s@x.com`, phone: `${TAG}s`, password: "x", roles: ["sales"], status: "active", roleId: icRole._id, reportingManagerId: manager._id });
    created.admins.push(manager._id, seller._id);

    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: seller._id,
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 50000, sellingPrice: 100000 }],
    });
    created.decors.push(decor._id);
    const lane = await LeadLane.create({ leadId: lead._id, key: "decor", name: "Decor", state: "active", ownerId: seller._id });
    created.lanes.push(lane._id);

    // Draft with ₹100,000 of décor
    const draft = await DraftEventService.createDraft(lead._id, { name: "Dream" }, seller._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" });
    await DraftEventService.addItem(lead._id, draft._id, day._id, { decorId: decor._id, quantity: 1 });

    // ── auto-approve within the 5% free band ──
    const small = await PlanSnapshotService.grantDiscount(lead._id, draft._id, { amount: 4000 }, seller._id);
    ok(small.status === "approved" && String(small.approvedBy) === String(seller._id), "≤ freePct → auto-approved");
    let totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.gross === 100000 && totals.discount === 4000 && totals.net === 96000, `gross/discount/net (${totals.gross}/${totals.discount}/${totals.net})`);

    // ── above the band → pending + notification + approvals row ──
    const big = await PlanSnapshotService.grantDiscount(lead._id, draft._id, { pct: 10 }, seller._id);
    ok(big.status === "pending" && big.amount === 10000, "10% → pending with the resolved amount");
    const notif = await AdminNotification.find({ leadId: lead._id, type: "discount_approval" }).lean();
    ok(notif.some((n) => String(n.adminId) === String(manager._id)), "the approver ladder is notified");
    totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.discount === 4000, "pending discounts do NOT count toward net");

    // approvals read gains the discount row (manager eligible via approve perm)
    const team = await TeamReadService.team(manager._id);
    const row = team.pendingApprovals.items.find((i) => i.type === "discount_approval" && String(i.lead._id) === String(lead._id));
    ok(!!row && row.discount.amount === 10000 && String(row.discount._id) === String(big._id), "Team approvals read carries the discount_approval row");
    ok(team.pendingApprovals.items.every((i) => i.type), "every approvals row now carries a type (additive)");

    // ── decide: ineligible then eligible ──
    let denied = null;
    try { await PlanSnapshotService.decideDiscount(big._id, "approve", seller._id); } catch (e) { denied = e; }
    ok(denied && denied.status === 403, "the giver can't approve their own big discount (403)");
    const decided = await PlanSnapshotService.decideDiscount(big._id, "approve", manager._id);
    ok(decided.status === "approved" && String(decided.approvedBy) === String(manager._id), "manager approves");
    totals = await DraftEventService.totalsFor(await DraftEventService.getDraft(lead._id, draft._id));
    ok(totals.discount === 14000 && totals.net === 86000, "approved discount lands in net");
    let twice = null;
    try { await PlanSnapshotService.decideDiscount(big._id, "reject", manager._id); } catch (e) { twice = e; }
    ok(twice && twice.status === 400, "double-decide → 400");

    // ── the décor-lane feed ──
    const feed = await PlanSnapshotService.feedDecorLane(lead._id, draft._id, seller._id);
    ok(feed.value === 86000, `feeds the NET décor total (${feed.value})`);
    const laneAfter = await LeadLane.findById(lane._id).lean();
    ok(laneAfter.price && laneAfter.price.amount === 86000 && laneAfter.price.status === "proposed", "Décor lane price proposed (editable as ever)");
    const entry = await LaneEntry.findOne({ laneId: lane._id, autoType: "lane_priced", text: /from draft "Dream"/ }).lean();
    ok(!!entry, `auto entry logs the feed ("${entry && entry.text}")`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await DealDiscount.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

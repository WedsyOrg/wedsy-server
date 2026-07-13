/**
 * Journey v2 — V3 (labels + money) + V4 (vendor sub-lanes).
 *
 *   node tests/journey-v2-lanes.test.js
 *
 * V3: displayStatus mapping both ways (no state-machine change), price
 * propose/confirm permissions + auto-entries, priced boolean.
 * V4: vendor:{service} proposal from servicesRequired, groupKey, assemble +
 * independent silence clocks, unassigned vendor lane routing in the sweep.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const EscalationMark = require("../models/EscalationMark");
const LeadLaneService = require("../services/LeadLaneService");
const EscalationSweepService = require("../services/EscalationSweepService");

const TAG = `jv2lane-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const throwsStatus = async (fn, status) => { try { await fn(); return false; } catch (e) { return e && e.status === status; } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [] };
  try {
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}-o@x.com`, phone: `${TAG}o`, password: "x",
      roles: ["sales"], status: "active",
    });
    const laneOwner = await Admin.create({
      name: `${TAG}-meera`, email: `${TAG}-l@x.com`, phone: `${TAG}l`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(owner._id, laneOwner._id);

    const lead = await Enquiry.create({
      name: `${TAG}-couple`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: owner._id, qualified: true, qualifiedAt: new Date(), firstRespondedAt: new Date(),
      qualificationData: { servicesRequired: ["Venue", "Photography", "Catering"], venueStatus: "looking" },
    });
    created.leads.push(lead._id);

    // ── V4: proposal derives vendor:{service} lanes with groupKey ────────────
    const { proposal } = await LeadLaneService.listLanes(String(lead._id));
    const photo = proposal.find((p) => p.key === "vendor:photography");
    const catering = proposal.find((p) => p.key === "vendor:catering");
    ok(photo && photo.name === "Photography" && photo.groupKey === "vendors",
      "servicesRequired → vendor:photography proposal { name, groupKey:'vendors' }");
    ok(catering && catering.groupKey === "vendors", "second vendor service proposes its own lane");
    ok(proposal.some((p) => p.key === "venue"), "core service still proposes the core lane");

    // Assemble: two vendor lanes (one unassigned) + core.
    await LeadLaneService.assemble(
      String(lead._id),
      {
        lanes: [
          { key: "venue", ownerId: String(laneOwner._id) },
          { key: "vendor:photography", ownerId: String(laneOwner._id) },
          { key: "vendor:catering" }, // unassigned — name derived from the key
          { key: "lead_comms" },
        ],
      },
      owner._id
    );
    const lanes = (await LeadLaneService.listLanes(String(lead._id))).lanes;
    const photoLane = lanes.find((l) => l.key === "vendor:photography");
    const cateringLane = lanes.find((l) => l.key === "vendor:catering");
    ok(photoLane && cateringLane, "assemble accepts vendor:{service} keys (unique per {leadId,key})");
    ok(cateringLane.name === "Catering", "vendor lane name derived from the key when omitted");
    ok(photoLane.groupKey === "vendors" && cateringLane.groupKey === "vendors",
      "lane rows carry groupKey:'vendors' (FE groups without string-parsing)");
    ok(lanes.find((l) => l.key === "venue").groupKey === null, "core lanes carry groupKey:null");

    // ── V3: displayStatus mapping ─────────────────────────────────────────────
    ok(photoLane.displayStatus === "Started", "active → 'Started'");
    await LeadLaneService.patchLane(String(lead._id), String(photoLane._id), { displayStatus: "Awaiting client" }, owner._id);
    let fresh = await LeadLane.findById(photoLane._id).lean();
    ok(fresh.state === "paused" && fresh.pausedReason === "client",
      "'Awaiting client' maps back to paused + reason 'client'");
    ok(LeadLaneService.displayStatusOf(fresh) === "Awaiting client", "paused(client) → 'Awaiting client'");
    await LeadLaneService.patchLane(String(lead._id), String(photoLane._id), { displayStatus: "started" }, owner._id);
    fresh = await LeadLane.findById(photoLane._id).lean();
    ok(fresh.state === "active", "'started' (snake/lower accepted) maps back to active");
    await LeadLaneService.patchLane(String(lead._id), String(photoLane._id), { displayStatus: "on_hold" }, owner._id);
    fresh = await LeadLane.findById(photoLane._id).lean();
    ok(fresh.state === "paused" && LeadLaneService.displayStatusOf(fresh) === "On hold",
      "'on_hold' → paused (non-client) → displays 'On hold'");
    ok(await throwsStatus(() => LeadLaneService.patchLane(String(lead._id), String(photoLane._id), { displayStatus: "bogus" }, owner._id), 400),
      "unknown label → 400");
    await LeadLaneService.patchLane(String(lead._id), String(photoLane._id), { displayStatus: "Started" }, owner._id);

    // ── V3: price propose/confirm ─────────────────────────────────────────────
    ok(photoLane.priced === false && photoLane.price === null, "unpriced lane exposes priced:false");
    // Lane owner proposes (scopeOk=false — out of lead scope).
    const p1 = await LeadLaneService.proposePrice(String(lead._id), String(photoLane._id), 650000, laneOwner._id, false);
    ok(p1.price.status === "proposed" && p1.price.amount === 650000 && String(p1.price.proposedBy) === String(laneOwner._id),
      "lane OWNER can propose a price out of lead scope");
    ok(await LaneEntry.exists({ laneId: photoLane._id, autoType: "lane_priced", text: /Priced ₹6,50,000/ }),
      "propose writes the 'priced ₹X' auto-entry");
    // Random third party (not lane owner, no scope) → 403.
    ok(await throwsStatus(() => LeadLaneService.proposePrice(String(lead._id), String(photoLane._id), 1, owner._id, false), 403),
      "non-owner without lead scope cannot price");
    // Confirm: lane owner (no scope) → 403; lead owner/manager (scopeOk) → confirmed.
    ok(await throwsStatus(() => LeadLaneService.confirmPrice(String(lead._id), String(photoLane._id), laneOwner._id, false), 403),
      "lane owner alone cannot CONFIRM (lead owner/manager only)");
    const c1 = await LeadLaneService.confirmPrice(String(lead._id), String(photoLane._id), owner._id, true);
    ok(c1.price.status === "confirmed" && String(c1.price.confirmedBy) === String(owner._id),
      "lead owner/manager confirms → status 'confirmed' + stamp");
    ok(await LaneEntry.exists({ laneId: photoLane._id, autoType: "lane_priced", text: /Price confirmed/ }),
      "confirm writes its auto-entry");
    const rows = (await LeadLaneService.listLanes(String(lead._id))).lanes;
    ok(rows.find((l) => l.key === "vendor:photography").priced === true, "lane row now priced:true");
    ok(await throwsStatus(() => LeadLaneService.confirmPrice(String(lead._id), String(cateringLane._id), owner._id, true), 409),
      "confirm without a proposal → 409");

    // ── V4: independent clocks + unassigned routing in the sweep ─────────────
    await LeadLane.updateOne({ _id: photoLane._id }, { $set: { lastUpdateAt: new Date(Date.now() - 5 * DAY_MS), state: "active" } });
    await LeadLane.updateOne({ _id: cateringLane._id }, { $set: { lastUpdateAt: new Date(), state: "active" } });
    const sweep = await EscalationSweepService.runSweep(new Date(), { leadFilter: { _id: { $in: [lead._id] } } });
    ok(sweep.laneSilent >= 1, `silent vendor lane rings (laneSilent=${sweep.laneSilent})`);
    const photoNotifs = await AdminNotification.find({ leadId: lead._id, type: "lane_silent", "payload.laneKey": "vendor:photography" }).lean();
    const cateringSilent = await AdminNotification.find({ leadId: lead._id, type: "lane_silent", "payload.laneKey": "vendor:catering", "payload.rung": 1 }).lean();
    ok(photoNotifs.length >= 1, "5d-silent vendor:photography escalated");
    ok(cateringSilent.length === 0, "fresh vendor:catering does NOT ring rung-1 (independent clocks)");
    // Unassigned catering lane → rung-2 routing (lead owner + RHs) fires even while fresh.
    const cateringUnassigned = await AdminNotification.find({ leadId: lead._id, type: "lane_silent", "payload.laneKey": "vendor:catering", "payload.rung": 2 }).lean();
    ok(cateringUnassigned.length >= 1 && cateringUnassigned[0].message.includes("NO owner"),
      "UNASSIGNED vendor lane routes to the lead owner + Revenue Heads (existing rung-2)");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await EscalationMark.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

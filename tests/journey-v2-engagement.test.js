/**
 * Journey v2 — V5: the engagement content library + pulse.
 *
 *   node tests/journey-v2-engagement.test.js
 *
 * Seeds present + validated CRUD + the 403 gate, mark-sent resets the lane
 * clock (kind "update"), log ordering (newest first), engagement-lane-only
 * guard, inactive item 422, pulseDays consumed by the sweep's rung 1.
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
const SettingsService = require("../services/SettingsService");
const LeadLaneService = require("../services/LeadLaneService");
const EscalationSweepService = require("../services/EscalationSweepService");
const settingsController = require("../controllers/settings");

const TAG = `jv2eng-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const throwsStatus = async (fn, status) => { try { await fn(); return false; } catch (e) { return e && e.status === status; } };
const mockRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [] };
  const savedItems = await SettingsService.get("engagement.items");
  const savedPulse = await SettingsService.get("engagement.pulseDays");
  try {
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}-o@x.com`, phone: `${TAG}o`, password: "x",
      roles: ["sales"], status: "active",
    });
    const stranger = await Admin.create({
      name: `${TAG}-stranger`, email: `${TAG}-s@x.com`, phone: `${TAG}s`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(owner._id, stranger._id);

    // ── Settings: seeds + validation + gate ──────────────────────────────────
    const items = await SettingsService.get("engagement.items");
    ok(Array.isArray(items) && items.length >= 8 && items.every((i) => i.id && i.caption && typeof i.active === "boolean"),
      `seed library present (${items.length} items with id/caption/active)`);
    ok((await SettingsService.get("engagement.pulseDays")) >= 1, "pulseDays default present");
    let bad = false;
    try { await SettingsService.set("engagement.items", [{ id: "", caption: "x", active: true }]); } catch (e) { bad = e.status === 400; }
    ok(bad, "items validation rejects a missing id");
    bad = false;
    try { await SettingsService.set("engagement.pulseDays", 99); } catch (e) { bad = e.status === 400; }
    ok(bad, "pulseDays validation rejects out-of-range");
    // Gate: a role-less admin (no settings_engagement:edit:all) → 403.
    const resGate = mockRes();
    await settingsController.GetEngagement({ auth: { user_id: String(stranger._id) } }, resGate);
    ok(resGate.statusCode === 403, `settings/engagement gated (got ${resGate.statusCode})`);

    // ── The pulse on a lane ──────────────────────────────────────────────────
    const lead = await Enquiry.create({
      name: `${TAG}-couple`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: owner._id, firstRespondedAt: new Date(),
    });
    created.leads.push(lead._id);
    const engLane = await LeadLane.create({
      leadId: lead._id, key: "engagement", name: "Client engagement", state: "active",
      ownerId: owner._id, lastUpdateAt: new Date(Date.now() - 3 * DAY_MS),
    });
    const otherLane = await LeadLane.create({
      leadId: lead._id, key: "decor", name: "Décor", state: "active",
      ownerId: owner._id, lastUpdateAt: new Date(),
    });

    const itemId = items[0].id;
    const before = (await LeadLane.findById(engLane._id).lean()).lastUpdateAt;
    const sent = await LeadLaneService.markEngagementSent(String(lead._id), String(engLane._id), itemId, owner._id, true);
    ok(sent.entry.kind === "update" && sent.entry.text === `Sent: ${items[0].caption}`,
      "mark-sent writes a kind:'update' entry 'Sent: {caption}'");
    const after = (await LeadLane.findById(engLane._id).lean()).lastUpdateAt;
    ok(+after > +before, "mark-sent RESETS the lane clock (lastUpdateAt bumped)");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "engagement_sent" }), "journey event engagement_sent");

    ok(await throwsStatus(() => LeadLaneService.markEngagementSent(String(lead._id), String(otherLane._id), itemId, owner._id, true), 400),
      "non-engagement lane → 400");
    ok(await throwsStatus(() => LeadLaneService.markEngagementSent(String(lead._id), String(engLane._id), "nope", owner._id, true), 404),
      "unknown itemId → 404");
    ok(await throwsStatus(() => LeadLaneService.markEngagementSent(String(lead._id), String(engLane._id), itemId, stranger._id, false), 403),
      "neither lane owner nor lead scope → 403");
    // Inactive item → 422.
    const toggled = items.map((i, ix) => (ix === 1 ? { ...i, active: false } : i));
    await SettingsService.set("engagement.items", toggled);
    ok(await throwsStatus(() => LeadLaneService.markEngagementSent(String(lead._id), String(engLane._id), items[1].id, owner._id, true), 422),
      "inactive item → 422");

    // ── Addendum: sender-readable ACTIVE library on the lane ─────────────────
    const active = await LeadLaneService.engagementItems(String(lead._id), String(engLane._id));
    ok(active.length >= 7 && active.every((i) => i.id && i.caption && !("active" in i)),
      "engagement-items returns ACTIVE items only, clean shape {id, caption, tone, imageUrl}");
    ok(!active.some((i) => i.id === items[1].id), "inactive item excluded from the sender read");
    ok(await throwsStatus(() => LeadLaneService.engagementItems(String(lead._id), String(otherLane._id)), 400),
      "engagement-items on a non-engagement lane → 400");

    // Log ordering.
    await new Promise((r) => setTimeout(r, 20));
    await LeadLaneService.markEngagementSent(String(lead._id), String(engLane._id), items[2].id, owner._id, true);
    const log = await LeadLaneService.engagementLog(String(lead._id), String(engLane._id));
    ok(log.length === 2 && log[0].item === items[2].caption && log[1].item === items[0].caption,
      "engagement-log newest first, captions clean");

    // ── pulseDays consumed by the sweep ──────────────────────────────────────
    // Silence the engagement lane 3d; pulse 2d → rings. Then pulse 7d → silent.
    await LeadLane.updateOne({ _id: engLane._id }, { $set: { lastUpdateAt: new Date(Date.now() - 3 * DAY_MS) } });
    await SettingsService.set("engagement.pulseDays", 2);
    let sweep = await EscalationSweepService.runSweep(new Date(), { leadFilter: { _id: { $in: [lead._id] } } });
    const rang = await AdminNotification.find({ leadId: lead._id, type: "lane_silent", "payload.laneKey": "engagement" }).lean();
    ok(rang.length >= 1, `3d-silent engagement lane rings at pulseDays=2 (laneSilent=${sweep.laneSilent})`);

    await AdminNotification.deleteMany({ leadId: lead._id }).catch(() => {});
    await EscalationMark.deleteMany({ leadId: lead._id }).catch(() => {});
    await SettingsService.set("engagement.pulseDays", 7);
    sweep = await EscalationSweepService.runSweep(new Date(), { leadFilter: { _id: { $in: [lead._id] } } });
    const quiet = await AdminNotification.find({ leadId: lead._id, type: "lane_silent", "payload.laneKey": "engagement", "payload.rung": 1 }).lean();
    ok(quiet.length === 0, "same silence does NOT ring rung-1 at pulseDays=7 (threshold reads settings)");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    // Restore settings exactly as found.
    await SettingsService.set("engagement.items", savedItems).catch(() => {});
    await SettingsService.set("engagement.pulseDays", savedPulse).catch(() => {});
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

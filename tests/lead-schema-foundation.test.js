/**
 * Lead-schema foundation — cockpit/brief redesign backend.
 *
 *   • Discovery gate reconciled to EXACTLY: canonical eventDate AND services.
 *   • New additive fields persist: qualificationData.city / destinationWedding /
 *     zones (venueArea retained, never dropped).
 *   • Canonical eventDate derives from the earliest dated EventBuilder day.
 *
 *   node tests/lead-schema-foundation.test.js
 *
 * Seeds an isolated, uniquely-tagged Enquiry against the local CRM DB; cleans up.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const CallCockpitService = require("../services/CallCockpitService");
const { computeDiscovery } = require("../services/DiscoveryService");

const TAG = `leadschema-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  let leadId = null;
  try {
    // ── Gate: complete ONLY when eventDate AND services both present (pure). ──
    console.log("Discovery gate (eventDate AND services)");
    const g = (qd, name) => computeDiscovery({ name, qualificationData: qd });
    ok(g({ eventDate: "2026-12-20", servicesRequired: ["Decor"] }).discoveryComplete === true,
      "eventDate + services → complete");
    const noServices = g({ eventDate: "2026-12-20" });
    ok(noServices.discoveryComplete === false && noServices.discovery.missing.includes("services"),
      "eventDate, no services → incomplete (missing services)");
    const noDate = g({ servicesRequired: ["Decor"] });
    ok(noDate.discoveryComplete === false && noDate.discovery.missing.includes("eventDate"),
      "services, no eventDate → incomplete (missing eventDate)");
    ok(g({ eventDatePart: "morning", servicesRequired: ["Decor"] }).discoveryComplete === false,
      "eventDatePart no longer satisfies the gate (retired)");
    ok(g({}, "Asha & Aarav").discoveryComplete === false,
      "name alone does NOT gate (name retired from gate)");

    // ── deriveCanonicalEventDate: earliest dated day; dateless → "" (pure). ──
    console.log("Canonical eventDate derivation");
    const derive = CallCockpitService.deriveCanonicalEventDate;
    ok(derive([{ date: "2026-12-22" }, { date: "2026-12-20" }, { date: "" }]) === "2026-12-20",
      "earliest of object days (ignores dateless)");
    ok(derive(["2027-01-05", "2026-11-30"]) === "2026-11-30", "earliest of string days");
    ok(derive([{ notFinalised: true }, { date: "" }]) === "" && derive([]) === "",
      "all dateless / empty → '' (eventDate stays empty)");
    let threw = false;
    try { derive("nope"); } catch (e) { threw = e.status === 400; }
    ok(threw, "non-array eventDays → 400");

    // ── Persistence via updateQualification (DB). ──
    console.log("Persistence: city / destinationWedding / zones (+ venueArea kept)");
    const lead = await Enquiry.create({
      name: "Schema Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default",
      qualificationData: { venueArea: "North Bengaluru" },
    });
    leadId = lead._id;

    await CallCockpitService.updateQualification(
      leadId,
      { city: "Mysore", destinationWedding: true, zones: ["south", "central", "south"], servicesRequired: ["Decor", "Makeup"] },
      null
    );
    let after = (await Enquiry.findById(leadId).lean()).qualificationData;
    ok(after.city === "Mysore", "city persisted (free-form string)");
    ok(after.destinationWedding === true, "destinationWedding persisted (boolean)");
    ok(Array.isArray(after.zones) && after.zones.join(",") === "south,central", "zones persisted + deduped");
    ok(after.venueArea === "North Bengaluru", "existing venueArea retained (not dropped)");

    // zones invalid value → 400, no mutation.
    let zoneThrew = false;
    try { await CallCockpitService.updateQualification(leadId, { zones: ["north", "moon"] }, null); }
    catch (e) { zoneThrew = e.status === 400; }
    ok(zoneThrew, "invalid zone value → 400");

    // ── Canonical eventDate sync via the PUT path (earliest day wins). ──
    console.log("Canonical eventDate sync via updateQualification");
    await CallCockpitService.updateQualification(
      leadId,
      // eventDays present alongside a raw eventDate — days are canonical.
      { eventDate: "2099-01-01", eventDays: [{ date: "2026-12-22" }, { date: "2026-12-20" }] },
      null
    );
    after = (await Enquiry.findById(leadId).lean()).qualificationData;
    ok(after.eventDate === "2026-12-20", "eventDate = earliest day (overrides raw eventDate in same payload)");

    await CallCockpitService.updateQualification(leadId, { eventDays: [{ notFinalised: true }] }, null);
    after = (await Enquiry.findById(leadId).lean()).qualificationData;
    ok(after.eventDate === "", "all-dateless days → eventDate cleared to ''");

    // End-to-end gate via computeDiscovery on the stored doc.
    await CallCockpitService.updateQualification(leadId, { eventDays: [{ date: "2026-12-20" }] }, null);
    const fresh = await Enquiry.findById(leadId).lean();
    ok(computeDiscovery(fresh).discoveryComplete === true,
      "stored doc with canonical date + services → gate complete end-to-end");
  } finally {
    if (leadId) await Enquiry.deleteMany({ _id: leadId });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });

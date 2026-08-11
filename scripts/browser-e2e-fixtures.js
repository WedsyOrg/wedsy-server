/* Browser-suite fixtures (wedsy-os Playwright e2e drives a real backend).
 *
 * setup    → creates a founder admin (all perms), a WhatsApp lead + live
 *            ai-mode conversation with an open 24h window and two messages,
 *            then prints ONE LINE of JSON: { token, leadId, conversationId }.
 * teardown → removes everything the marker identifies. Idempotent.
 *
 * Usage: node scripts/browser-e2e-fixtures.js setup|teardown
 */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const MARKER = "BROWSER-E2E";
const LEAD_PHONE = "919180000001";
const ADMIN_PHONE = "919180000002";
// MB8c-2a-i — a dedicated QUALIFIED lead (with roster + journey steps + brief
// facts) so the command-center e2e never has to mutate the pristine LEAD_PHONE.
const QUALIFIED_LEAD_PHONE = "919180000004";
// MB9a — a dedicated PRE-QUAL intake lead the lifecycle e2e can qualify without
// touching the shared LEAD_PHONE fixture.
const INTAKE_LEAD_PHONE = "919180000005";
// MB11c — a lead qualified THROUGH the hinge, carrying pre-qual history (call
// logs with notes + a note event) so the continuity e2e can prove the command
// center surfaces the qualifier's record, "qualified by X", and the timeline.
const CONTINUITY_LEAD_PHONE = "919180000006";
// MB-OSV — venue-department fixtures. Four venues spanning the two-track
// matrix so the venue e2e can assert the facets and the 360 without ever
// mutating a lead fixture. Slugs carry the marker so teardown is exact.
const VENUE_SLUGS = {
  raw: "browser-e2e-venue-raw",
  verified: "browser-e2e-venue-verified",
  granted: "browser-e2e-venue-granted",
  partner: "browser-e2e-venue-partner",
};

(async () => {
  const cmd = process.argv[2];
  if (!["setup", "teardown"].includes(cmd)) {
    console.error("usage: node scripts/browser-e2e-fixtures.js setup|teardown");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  // MB8a/MB8b/MB8c-1 — clean the journey artifacts the browser suite creates on
  // the fixture lead so they don't orphan across runs.
  const LeadStep = require("../models/LeadStep");
  const LeadTeamMember = require("../models/LeadTeamMember");
  const LeadChatMessage = require("../models/LeadChatMessage");

  const LeadTask = require("../models/LeadTask");
  const cleanLeadArtifacts = async (phone) => {
    const l = await Enquiry.findOne({ phone }).lean();
    if (!l) return;
    await LeadInternalEvent.deleteMany({ leadId: l._id });
    await LeadStep.deleteMany({ leadId: l._id });
    await LeadTeamMember.deleteMany({ leadId: l._id });
    await LeadChatMessage.deleteMany({ leadId: l._id });
    await LeadTask.deleteMany({ leadId: l._id });
  };

  const teardown = async () => {
    await cleanLeadArtifacts(LEAD_PHONE);
    await cleanLeadArtifacts(QUALIFIED_LEAD_PHONE);
    await cleanLeadArtifacts(INTAKE_LEAD_PHONE);
    await cleanLeadArtifacts(CONTINUITY_LEAD_PHONE);
    await Enquiry.deleteMany({ phone: { $in: [LEAD_PHONE, QUALIFIED_LEAD_PHONE, INTAKE_LEAD_PHONE, CONTINUITY_LEAD_PHONE] } });
    await WAConversation.deleteMany({ phone: LEAD_PHONE });
    await WAAgentMessage.deleteMany({ phone: LEAD_PHONE });
    await Admin.deleteMany({ phone: ADMIN_PHONE });
    await Role.deleteMany({ name: `${MARKER} Founder` });
    await Department.deleteMany({ name: `${MARKER} Dept` });
    // MB-OSV venue fixtures + everything hanging off them.
    const Venue = require("../models/Venue");
    const VenueOwner = require("../models/VenueOwner");
    const VenuePartnerVisit = require("../models/VenuePartnerVisit");
    const VenueLeadAssist = require("../models/VenueLeadAssist");
    const VenueWorkTarget = require("../models/VenueWorkTarget");
    const VenueActivity = require("../models/VenueActivity");
    const slugs = Object.values(VENUE_SLUGS);
    const vs = await Venue.find({ slug: { $in: slugs } }).select("_id").lean();
    const vids = vs.map((v) => v._id);
    if (vids.length) {
      await VenueOwner.deleteMany({ venueId: { $in: vids } });
      await VenuePartnerVisit.deleteMany({ venue: { $in: vids } });
      await VenueLeadAssist.deleteMany({ venue: { $in: vids } });
      await VenueActivity.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    }
    await VenueWorkTarget.deleteMany({});
  };

  if (cmd === "teardown") {
    await teardown();
    await mongoose.disconnect();
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  await teardown(); // clean slate even after a crashed previous run

  const dept = await Department.create({ name: `${MARKER} Dept` });
  const role = await Role.create({
    name: `${MARKER} Founder`,
    departmentId: dept._id,
    permissions: ["*:*:all"],
  });
  const admin = await Admin.create({
    name: "Browser Founder",
    email: `browser-e2e-${Date.now()}@test.local`,
    phone: ADMIN_PHONE,
    password: "browser-e2e-not-a-real-password",
    roles: ["crm"],
    roleId: role._id,
    departmentId: dept._id,
    status: "active",
  });
  const token = jwt.sign({ _id: String(admin._id), isAdmin: true }, process.env.JWT_SECRET);

  const lead = await Enquiry.create({
    name: "Browser E2E Lead",
    phone: LEAD_PHONE,
    verified: false,
    source: "whatsapp",
    additionalInfo: {},
    stage: "new",
    assignedTo: admin._id,
  });
  const now = new Date();
  const conversation = await WAConversation.create({
    phone: LEAD_PHONE,
    normalizedPhone: LEAD_PHONE.slice(-10),
    enquiryId: lead._id,
    mode: "ai",
    status: "active",
    lastInboundAt: now, // 24h window OPEN — the send flow must work
    lastMessageAt: now,
    lastMessagePreview: "Hi! Planning my wedding",
    unreadCount: 1,
  });
  await WAAgentMessage.create([
    { phone: LEAD_PHONE, role: "user", message: "Hi! Planning my wedding" },
    { phone: LEAD_PHONE, role: "assistant", message: "How lovely! Tell me more ✦" },
  ]);

  // ── MB8c-2a-i — a QUALIFIED lead for the command-center e2e ──────────────────
  // (LeadTeamMember is already required above for teardown.)
  const StepDefinitionService = require("../services/StepDefinitionService");
  const LeadStepService = require("../services/LeadStepService");
  const qLead = await Enquiry.create({
    name: "Aarav Mehta",
    phone: QUALIFIED_LEAD_PHONE,
    verified: true,
    source: "whatsapp",
    stage: "qualified",
    qualified: true,
    assignedTo: admin._id,
    qualificationData: { groomName: "Aarav", brideName: "Diya", weddingStyle: "Boho", venueArea: "Goa", venueStatus: "looking", servicesRequired: ["Decor", "Makeup"], budgetAmount: 1500000 },
    additionalInfo: { adFormAnswers: { city: "Goa", weddingDate: "2026-12-12", guests: "300" } },
  });
  // The founder is on the roster (so they can own steps/tasks); seed defs + steps.
  await LeadTeamMember.create({ leadId: qLead._id, personId: admin._id, departmentName: `${MARKER} Dept`, addedBy: admin._id });
  await StepDefinitionService.seed();
  await LeadStepService.instantiateForLead(qLead._id, admin._id);

  // ── MB9a — a PRE-QUAL intake lead (assigned to the founder, no journey/roster)
  // the lifecycle e2e can qualify.
  const intakeLead = await Enquiry.create({
    name: "Ishaan Rao",
    phone: INTAKE_LEAD_PHONE,
    verified: false,
    source: "Website",
    stage: "new",
    assignedTo: admin._id,
    additionalInfo: {},
  });

  // ── MB11c — a lead with PRE-QUAL history, qualified through the real hinge ──
  // Pre-qual call logs (with notes) + Kiara facts live on the doc; a note event
  // + the qualifyLead transition give the command center a full timeline and the
  // "qualified by X · date" credit. qualifyLead sets qualifiedBy/qualifiedAt.
  const LeadInternalEventService = require("../services/LeadInternalEventService");
  const LeadLifecycleService = require("../services/LeadLifecycleService");
  const contLead = await Enquiry.create({
    name: "Veer & Tara",
    phone: CONTINUITY_LEAD_PHONE,
    verified: true,
    source: "Website",
    stage: "contacted",
    assignedTo: admin._id,
    qualificationData: { groomName: "Veer", brideName: "Tara", weddingStyle: "Classic", venueArea: "Jaipur", servicesRequired: ["Decor"] },
    additionalInfo: { kiaraAnswers: { city: "Jaipur", budget: "20L" } },
    callLog: [
      { startedAt: new Date(Date.now() - 3600000), durationSeconds: 0, connected: false, outcome: "", notes: "No answer — left a voicemail.", loggedBy: admin._id },
      { startedAt: new Date(Date.now() - 1800000), durationSeconds: 240, connected: true, outcome: "qualified", notes: "Discovery call: 20L budget, Jaipur, Dec wedding.", loggedBy: admin._id },
    ],
    updates: { notes: "Keen couple — send the deck before the next call." },
  });
  await LeadInternalEventService.record({
    leadId: contLead._id,
    type: "commented",
    actorId: admin._id,
    payload: { text: "Keen couple — send the deck before the next call." },
  });
  // The real hinge: sets qualified + qualifiedBy + qualifiedAt, records the
  // "qualified" event, instantiates the journey (idempotent).
  await LeadLifecycleService.qualifyLead(contLead._id, admin._id);

  // ── MB-OSV venue fixtures ────────────────────────────────────────────────
  // One venue per interesting two-track combination. `granted` is the important
  // one: access granted, never signed in — the state the partner badge must
  // refuse to light for.
  const Venue = require("../models/Venue");
  const vNow = new Date();
  // Delete-then-create rather than upsert: setDefaultsOnInsert materialises the
  // empty `location` default, which the 2dsphere index rejects as invalid
  // GeoJSON. Venue.create() is also how every venue test builds fixtures.
  const mkVenue = async (slug, name, extra) => {
    await Venue.deleteOne({ slug });
    return Venue.create({ name, slug, city: "Bengaluru", zone: "south", venueType: "resort", status: "published", dataCompleteness: 50, ...extra });
  };

  const vRaw = await mkVenue(VENUE_SLUGS.raw, `${MARKER} Raw Venue`, {
    entryPoint: "scraped",
    verified: { isVerified: false },
    enrichment: { completeness: 0, missingFields: ["pricing", "photos"] },
    partner: {},
  });
  const vVerified = await mkVenue(VENUE_SLUGS.verified, `${MARKER} Verified Venue`, {
    entryPoint: "walk_up",
    verified: { isVerified: true, verifiedAt: vNow, verifiedBy: admin._id, notes: "Checked by e2e fixture" },
    enrichment: { completeness: 95, missingFields: [], lastEnrichedAt: vNow, lastEnrichedBy: admin._id },
    partner: {},
  });
  const vGranted = await mkVenue(VENUE_SLUGS.granted, `${MARKER} Granted Venue`, {
    entryPoint: "claimed",
    verified: { isVerified: false },
    partner: {
      accessGrantedAt: vNow,
      accessGrantedBy: admin._id,
      accessGrantTrigger: "wedsy_select",
      primaryPhone: "919180000101",
      onboarding: { status: "in_progress" },
    },
  });
  const vPartner = await mkVenue(VENUE_SLUGS.partner, `${MARKER} Partner Venue`, {
    entryPoint: "claimed",
    verified: { isVerified: true, verifiedAt: vNow, verifiedBy: admin._id },
    enrichment: { completeness: 90, missingFields: [], lastEnrichedAt: vNow },
    partner: {
      accessGrantedAt: vNow,
      accessGrantedBy: admin._id,
      accessGrantTrigger: "claim_approval",
      primaryPhone: "919180000102",
      firstOwnerLoginAt: vNow,
      terms: { unconditional: false, commissionPercent: 7, inHousePlanner: false, decorRights: false },
      onboarding: { status: "in_progress", stages: [{ key: "kickoff_call", label: "Kick-off call", done: true, completedAt: vNow }] },
    },
  });

  await mongoose.disconnect();
  console.log(
    JSON.stringify({ token, leadId: String(lead._id), conversationId: String(conversation._id), qualifiedLeadId: String(qLead._id), intakeLeadId: String(intakeLead._id), continuityLeadId: String(contLead._id), venues: VENUE_SLUGS, venueIds: { raw: String(vRaw._id), verified: String(vVerified._id), granted: String(vGranted._id), partner: String(vPartner._id) } })
  );
})();

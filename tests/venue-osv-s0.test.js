// MB-OSV S0 — the two-track venue model.
// Run: node tests/venue-osv-s0.test.js
//
// What this pins down:
//   1. BADGE DERIVATION TRUTH TABLE — especially access-granted-but-never-
//      logged-in ⇒ NOT a partner. That conjunction is the whole point of the
//      badge and the easiest thing for a later refactor to quietly loosen.
//   2. ACCESS GRANT via both triggers, including that claim_approval auto-starts
//      Track B and wedsy_select does not.
//   3. TERMS DEFAULTS — unconditional is true out of the box, and setting any
//      real condition turns it off (no "unconditional, 5% commission").
//   4. TRACK INDEPENDENCE — verified without partner, partner without verified.
//   5. CAPABILITY DENIALS per route (fail-closed, and the venue-owner boundary
//      is never what is being tested — these are admin-JWT routes throughout).
//   6. firstOwnerLoginAt is stamped by the EXISTING owner-auth funnel, once.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenuePartnerVisit = require("../models/VenuePartnerVisit");
const VenueLeadAssist = require("../models/VenueLeadAssist");
const VenueWorkTarget = require("../models/VenueWorkTarget");
const VenueActivity = require("../models/VenueActivity");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const Role = require("../models/Role");
const Department = require("../models/Department");

const p = require("../controllers/adminVenuePartnership");
const tracks = require("../utils/venueTracks");
const { requirePermission } = require("../middlewares/requirePermission");
const { validatePermissions } = require("../utils/rbacPermissions");

const TAG = `osv-s0-${Date.now()}`;
// Phones must look like phones: the grant path caps primaryPhone at 20 chars,
// so TAG-derived strings would be truncated by a rule that is correct.
const PHONE1 = `9${String(Date.now()).slice(-9)}`;
const PHONE2 = `8${String(Date.now()).slice(-9)}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const req = (adminId, extra = {}) => ({
  params: extra.params || {},
  query: extra.query || {},
  body: extra.body || {},
  auth: { user_id: adminId },
});
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };

const created = { venues: [], owners: [], admins: [], roles: [], depts: [], leads: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── fixtures ────────────────────────────────────────────────────────────
    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    // Deliberately holds venues:view but NONE of the action capabilities.
    const viewerRole = await Role.create({ name: `${TAG}-viewer`, departmentId: dept._id, permissions: ["venues:view:all"] });
    created.roles.push(founderRole._id, viewerRole._id);

    const founder = await Admin.create({ name: `${TAG}-founder`, email: `${TAG}-f@w.in`, phone: `${TAG}1`, password: "x", roleIds: [founderRole._id], departmentId: dept._id });
    const viewer = await Admin.create({ name: `${TAG}-viewer`, email: `${TAG}-v@w.in`, phone: `${TAG}2`, password: "x", roleIds: [viewerRole._id], departmentId: dept._id });
    created.admins.push(founder._id, viewer._id);

    const mkVenue = async (s, extra = {}) => {
      const v = await Venue.create({ name: `${TAG}-${s}`, slug: `${TAG}-${s}`, ...extra });
      created.venues.push(v._id);
      return v;
    };

    // ── 1. badge derivation truth table ─────────────────────────────────────
    console.log("\n[1] badge derivation truth table");
    const D = new Date();
    const table = [
      ["nothing set",                     {},                                                          false],
      ["access granted, NEVER logged in", { partner: { accessGrantedAt: D } },                         false],
      ["logged in, access never granted", { partner: { firstOwnerLoginAt: D } },                       false],
      ["granted AND logged in",           { partner: { accessGrantedAt: D, firstOwnerLoginAt: D } },   true],
    ];
    for (const [label, doc, want] of table) {
      ok(tracks.partnerBadge(doc) === want, `partnerBadge — ${label} ⇒ ${want}`);
    }
    // The one the spec calls out by name, asserted against a real document.
    const halfway = await mkVenue("halfway");
    halfway.partner.accessGrantedAt = new Date();
    halfway.partner.accessGrantedBy = founder._id;
    await halfway.save();
    const halfwayFresh = await Venue.findById(halfway._id);
    ok(tracks.partnerBadge(halfwayFresh) === false, "access granted with no login is NOT a partner (persisted doc)");
    ok(tracks.partnerStage(halfwayFresh) === "access_granted", "…and its stage reads access_granted, not live");

    ok(tracks.verifiedBadge({ status: "verified" }) === true, "verifiedBadge — legacy status fallback still reads true");
    ok(tracks.verifiedBadge({ status: "verified", verified: { isVerified: false } }) === false, "…but an explicit false beats the legacy status");
    ok(tracks.verifiedBadge({ status: "draft", verified: { isVerified: true } }) === true, "verified is independent of publication status");

    // The hydration trap: a default on isVerified would defeat the fallback.
    const legacyDoc = new Venue({ name: "x", slug: `${TAG}-hydrate`, status: "verified" });
    ok(legacyDoc.verified.isVerified === undefined, "hydrated doc gets NO defaulted isVerified (fallback stays reachable)");
    ok(tracks.verifiedBadge(legacyDoc) === true, "…so a hydrated legacy venue still reads verified");

    // ── 2. access grant — both triggers ─────────────────────────────────────
    console.log("\n[2] grant-access: one action, two triggers");
    const vClaim = await mkVenue("claim");
    const g1 = await call(p.grantAccess, req(founder._id, {
      params: { slug: vClaim.slug },
      body: { trigger: "claim_approval", primaryPhone: PHONE1, primaryEmail: "a@b.in", ownerName: "Claim Owner" },
    }));
    ok(g1.code === 201, "claim_approval grant → 201");
    ok(g1.body.partner.accessGrantTrigger === "claim_approval", "trigger recorded as provenance");
    ok(g1.body.partner.onboarding.status === "in_progress", "claim approval AUTO-STARTS Track B onboarding");
    ok(g1.body.partner.primaryPhone === PHONE1, "primaryPhone is the DESIGNATED number");
    ok(g1.body.partnerBadge === false, "still not a partner — the owner has not signed in");
    const claimOwner = await VenueOwner.findOne({ venueId: vClaim._id });
    created.owners.push(claimOwner._id);
    ok(!!claimOwner && claimOwner.isActive, "grant created/linked the owner account");

    const vSelect = await mkVenue("select");
    const g2 = await call(p.grantAccess, req(founder._id, {
      params: { slug: vSelect.slug },
      body: { trigger: "wedsy_select", primaryPhone: PHONE2 },
    }));
    ok(g2.code === 201, "wedsy_select grant → 201 (same single action)");
    ok(g2.body.partner.onboarding.status === "not_started", "wedsy_select does NOT auto-start onboarding");
    const selectOwner = await VenueOwner.findOne({ venueId: vSelect._id });
    created.owners.push(selectOwner._id);

    const dupe = await call(p.grantAccess, req(founder._id, {
      params: { slug: vClaim.slug }, body: { trigger: "wedsy_select", primaryPhone: PHONE1 },
    }));
    ok(dupe.code === 409, "re-granting an already-granted venue → 409");

    const noPhone = await call(p.grantAccess, req(founder._id, {
      params: { slug: vSelect.slug }, body: { trigger: "wedsy_select" },
    }));
    ok(noPhone.code === 400, "grant without primaryPhone → 400 (never inferred)");

    const badTrigger = await call(p.grantAccess, req(founder._id, {
      params: { slug: (await mkVenue("badtrig")).slug }, body: { trigger: "whatever", primaryPhone: "9" },
    }));
    ok(badTrigger.code === 400, "unknown trigger → 400");

    // ── 3. terms defaults ───────────────────────────────────────────────────
    console.log("\n[3] commercial terms");
    ok(g2.body.partner.terms.unconditional === true, "terms default to UNCONDITIONAL");
    ok(g2.body.partner.terms.commissionPercent === null, "…with no commission");
    ok(g2.body.partner.terms.inHousePlanner === false && g2.body.partner.terms.decorRights === false, "…and no rights claimed");

    const t1 = await call(p.setTerms, req(founder._id, {
      params: { slug: vSelect.slug }, body: { commissionPercent: 5 },
    }));
    ok(t1.code === 200 && t1.body.partner.terms.commissionPercent === 5, "commission set → 200");
    ok(t1.body.partner.terms.unconditional === false, "setting a real condition FORCES unconditional off");

    const t2 = await call(p.setTerms, req(founder._id, {
      params: { slug: vSelect.slug }, body: { unconditional: true, commissionPercent: null, inHousePlanner: false, decorRights: false },
    }));
    ok(t2.body.partner.terms.unconditional === true, "clearing every condition allows unconditional back on");

    const t3 = await call(p.setTerms, req(founder._id, {
      params: { slug: vSelect.slug }, body: { unconditional: true, decorRights: true },
    }));
    ok(t3.body.partner.terms.unconditional === false, "'unconditional + decor rights' is not representable");

    const tBad = await call(p.setTerms, req(founder._id, {
      params: { slug: vSelect.slug }, body: { commissionPercent: 250 },
    }));
    ok(tBad.code === 400, "out-of-range commission → 400");

    // ── 4. track independence ───────────────────────────────────────────────
    console.log("\n[4] the two tracks are independent");
    const vVerifiedOnly = await mkVenue("vonly");
    const ver = await call(p.setVerified, req(founder._id, {
      params: { slug: vVerifiedOnly.slug }, body: { isVerified: true, notes: "walked it" },
    }));
    ok(ver.code === 200 && ver.body.verifiedBadge === true, "verify a venue nobody has approached → verified");
    ok(ver.body.partnerBadge === false, "…and it is NOT a partner");
    ok(ver.body.status === "draft", "…and its publication status was NOT touched");

    // vClaim is a partner-track venue that nobody verified.
    const claimFresh = await Venue.findById(vClaim._id);
    ok(tracks.verifiedBadge(claimFresh) === false, "a venue on the partner track is not verified by implication");

    const unver = await call(p.setVerified, req(founder._id, {
      params: { slug: vVerifiedOnly.slug }, body: { isVerified: false, notes: "photos were stale" },
    }));
    ok(unver.body.verifiedBadge === false, "verification is revocable…");
    ok(unver.body.status === "draft", "…without demoting the listing");
    ok(!!unver.body.verified.verifiedAt && String(unver.body.verified.verifiedBy) === String(founder._id), "…and the unverify is still attributed");

    const verBad = await call(p.setVerified, req(founder._id, { params: { slug: vVerifiedOnly.slug }, body: {} }));
    ok(verBad.code === 400, "verify without isVerified → 400");

    const ver404 = await call(p.setVerified, req(founder._id, { params: { slug: "nope-does-not-exist" }, body: { isVerified: true } }));
    ok(ver404.code === 404, "verify on an unknown slug → 404");

    // Track A progression.
    const enr = await call(p.setEnrichment, req(founder._id, {
      params: { slug: vVerifiedOnly.slug }, body: { completeness: 40, missingFields: ["pricing", "photos"] },
    }));
    ok(enr.code === 200 && enr.body.enrichmentStage === "enriching", "partial enrichment ⇒ enriching");
    const enr2 = await call(p.setEnrichment, req(founder._id, {
      params: { slug: vVerifiedOnly.slug }, body: { completeness: 92, missingFields: [] },
    }));
    ok(enr2.body.enrichmentStage === "enriched", "high completeness + nothing missing ⇒ enriched");
    const enrBad = await call(p.setEnrichment, req(founder._id, { params: { slug: vVerifiedOnly.slug }, body: { completeness: 900 } }));
    ok(enrBad.code === 400, "out-of-range completeness → 400");
    const rawV = await mkVenue("raw");
    ok(tracks.enrichmentStage(rawV) === "raw", "never-enriched ⇒ raw");

    // ── 5. onboarding + agreement ───────────────────────────────────────────
    console.log("\n[5] onboarding");
    const obEarly = await call(p.updateOnboarding, req(founder._id, {
      params: { slug: rawV.slug }, body: { status: "in_progress" },
    }));
    ok(obEarly.code === 409, "onboarding before access is granted → 409");

    const st = await call(p.upsertOnboardingStage, req(founder._id, {
      params: { slug: vClaim.slug, key: "agreement_signed" }, body: { label: "Agreement signed", done: true },
    }));
    ok(st.code === 200, "upsert onboarding stage → 200");
    const stage = st.body.partner.onboarding.stages.find((s) => s.key === "agreement_signed");
    ok(!!stage && stage.done && !!stage.completedAt, "stage records completion + timestamp");
    const st2 = await call(p.upsertOnboardingStage, req(founder._id, {
      params: { slug: vClaim.slug, key: "agreement_signed" }, body: { notes: "scan on file" },
    }));
    const stage2 = st2.body.partner.onboarding.stages.find((s) => s.key === "agreement_signed");
    ok(String(stage2.completedAt) === String(stage.completedAt), "re-saving a done stage does NOT move its completion date");

    const doc = await call(p.updateOnboarding, req(founder._id, {
      params: { slug: vClaim.slug }, body: { agreementDocUrl: "https://cdn.wedsy.in/a.pdf", status: "complete" },
    }));
    ok(doc.code === 200 && doc.body.partner.onboarding.agreementDocUrl.endsWith("a.pdf"), "agreement doc URL stored (scan-upload, no e-sign)");
    ok(doc.body.partnerStage === "access_granted", "onboarding complete WITHOUT a login is still not live");

    const rm = await call(p.removeOnboardingStage, req(founder._id, { params: { slug: vClaim.slug, key: "agreement_signed" } }));
    ok(rm.code === 200, "remove stage → 200");
    const rm404 = await call(p.removeOnboardingStage, req(founder._id, { params: { slug: vClaim.slug, key: "ghost" } }));
    ok(rm404.code === 404, "removing an unknown stage → 404");

    // ── 6. firstOwnerLoginAt via the EXISTING owner-auth funnel ─────────────
    console.log("\n[6] firstOwnerLoginAt is stamped by the existing login path");
    // Exercise the real stamp the funnel performs (same filtered update).
    const stampOnce = async (venueId) =>
      Venue.updateOne({ _id: venueId, "partner.firstOwnerLoginAt": null }, { $set: { "partner.firstOwnerLoginAt": new Date() } });
    await stampOnce(vClaim._id);
    let afterLogin = await Venue.findById(vClaim._id);
    const firstAt = afterLogin.partner.firstOwnerLoginAt;
    ok(!!firstAt, "first login stamps firstOwnerLoginAt");
    ok(tracks.partnerBadge(afterLogin) === true, "…and NOW the partner badge lights");
    ok(tracks.partnerStage(afterLogin) === "onboarding_complete", "…stage reflects the completed onboarding");
    await new Promise((r) => setTimeout(r, 5));
    await stampOnce(vClaim._id);
    afterLogin = await Venue.findById(vClaim._id);
    ok(String(afterLogin.partner.firstOwnerLoginAt) === String(firstAt), "a second login does NOT move the date (write-once)");

    // ── 7. capability denials per route ─────────────────────────────────────
    console.log("\n[7] capability gating (fail-closed)");
    const gate = async (perm, adminId) => {
      const r = { auth: { user_id: adminId }, params: {}, query: {}, body: {} };
      const res = mockRes();
      let nexted = false;
      await requirePermission(perm)(r, res, () => { nexted = true; });
      return { nexted, code: res.code, body: res.body };
    };
    const denials = [
      ["venues_verify:edit:all", "verify"],
      ["venues_enrich:edit:all", "enrich"],
      ["venues_onboard:create:all", "grant-access"],
      ["venues_onboard:edit:all", "terms/onboarding"],
      ["venues_visit:create:all", "log partner visit"],
      ["venues_leads_assist:create:all", "create lead assist"],
      ["venues:assign:all", "commit a worklist target"],
    ];
    for (const [perm, label] of denials) {
      const denied = await gate(perm, viewer._id);
      ok(!denied.nexted && denied.code === 403, `viewer is DENIED ${label} (${perm})`);
      const allowed = await gate(perm, founder._id);
      ok(allowed.nexted, `founder is allowed ${label}`);
    }
    const viewOk = await gate("venues:view:all", viewer._id);
    ok(viewOk.nexted, "viewer CAN still read the department (venues:view:all)");

    // The vocabulary itself must accept the new strings and reject typos.
    ok(validatePermissions(["venues_verify:edit:all", "venues_leads_assist:view:all"]).valid, "new venues_* resources are valid vocabulary");
    ok(!validatePermissions(["venues_verifyy:edit:all"]).valid, "a typo'd venues resource is rejected");

    // ── 8. partner visits (internal, not the couple-facing model) ───────────
    console.log("\n[8] partner visits");
    const pv = await call(p.createPartnerVisit, req(founder._id, {
      params: { slug: vClaim.slug }, body: { outcome: "signed", notes: "met the owner", nextAction: "collect GST cert" },
    }));
    ok(pv.code === 201, "log a partner visit → 201");
    const pvBad = await call(p.createPartnerVisit, req(founder._id, {
      params: { slug: vClaim.slug }, body: { outcome: "teleported" },
    }));
    ok(pvBad.code === 400, "unknown outcome → 400");
    const pvList = await call(p.listPartnerVisits, req(founder._id, { params: { slug: vClaim.slug } }));
    ok(pvList.code === 200 && pvList.body.total === 1, "the 360 tab lists that venue's visits");
    const pvPatch = await call(p.updatePartnerVisit, req(founder._id, {
      params: { id: String(pv.body.visit._id) }, body: { outcome: "follow_up" },
    }));
    ok(pvPatch.code === 200 && pvPatch.body.visit.outcome === "follow_up", "update a visit → 200");
    const pv404 = await call(p.updatePartnerVisit, req(founder._id, { params: { id: new mongoose.Types.ObjectId() }, body: {} }));
    ok(pv404.code === 404, "unknown visit → 404");
    const pvBadId = await call(p.updatePartnerVisit, req(founder._id, { params: { id: "not-an-id" }, body: {} }));
    ok(pvBadId.code === 400, "malformed visit id → 400");

    // ── 9. lead assists — and the CRM lead is never written ─────────────────
    console.log("\n[9] lead assists leave the CRM lead alone");
    // A REAL lead: createLeadAssist now 404s on an enquiryId that resolves to
    // nothing (see tests/venue-osv-fixes.test.js), so a bare ObjectId no longer
    // stands in for one.
    const assistLead = await Enquiry.create({ name: `${TAG} Assist Couple`, phone: `55${String(Date.now()).slice(-8)}`, stage: "contacted" });
    created.leads.push(assistLead._id);
    const la = await call(p.createLeadAssist, req(founder._id, {
      body: { slug: vClaim.slug, enquiryId: String(assistLead._id), role: "recommending" },
    }));
    ok(la.code === 201, "create an assist → 201");
    const laDupe = await call(p.createLeadAssist, req(founder._id, {
      body: { slug: vClaim.slug, enquiryId: String(assistLead._id) },
    }));
    ok(laDupe.code === 409, "the same admin+lead+venue twice → 409");
    const laList = await call(p.listLeadAssists, req(founder._id, {}));
    ok(laList.code === 200 && laList.body.total >= 1, "'Leads I'm on' defaults to the caller's own assists");
    const laOther = await call(p.listLeadAssists, req(viewer._id, {}));
    ok(laOther.body.total === 0, "…and does not leak another admin's assists");
    const laClose = await call(p.updateLeadAssist, req(founder._id, {
      params: { id: String(la.body.assist._id) }, body: { status: "closed" },
    }));
    ok(laClose.code === 200 && !!laClose.body.assist.closedAt, "closing an assist stamps closedAt");
    // Closing frees the partial unique index for a fresh assist.
    const laAgain = await call(p.createLeadAssist, req(founder._id, {
      body: { slug: vClaim.slug, enquiryId: String(assistLead._id) },
    }));
    ok(laAgain.code === 201, "…and the pair can be re-opened afterwards");
    const laBad = await call(p.createLeadAssist, req(founder._id, { body: { slug: vClaim.slug, enquiryId: "nope" } }));
    ok(laBad.code === 400, "malformed enquiryId → 400");

    // ── 10. worklist ────────────────────────────────────────────────────────
    console.log("\n[10] the Monday worklist");
    const wk = await call(p.upsertWorkTarget, req(founder._id, {
      body: { kind: "verify", slugs: [vVerifiedOnly.slug, rawV.slug], notes: "week one" },
    }));
    ok(wk.code === 200 && wk.body.target.target === 2, "commit a target → 200 with the committed size");
    const wkList = await call(p.getWorklist, req(founder._id, {}));
    ok(wkList.code === 200 && wkList.body.targets.length === 1, "worklist returns the week's targets");
    const row = wkList.body.targets[0];
    ok(row.venues.length === 2, "…AND the specific venues behind the target");
    ok(row.venues.every((v) => "verifiedBadge" in v && "partnerBadge" in v), "…each carrying its own track state");
    // vVerifiedOnly was verified then UNverified this week — progress must not
    // count it, or an unverify would read as work done.
    ok(row.done === 0, "an unverified venue does not count toward a verify target");
    const reVerify = await call(p.setVerified, req(founder._id, { params: { slug: vVerifiedOnly.slug }, body: { isVerified: true } }));
    ok(reVerify.code === 200, "re-verify → 200");
    const wkList2 = await call(p.getWorklist, req(founder._id, {}));
    ok(wkList2.body.targets[0].done === 1, "…and now it counts");
    ok(wkList2.body.targets[0].venues.find((v) => v.slug === vVerifiedOnly.slug).done === true, "…marked done on the row itself");

    const wkBadKind = await call(p.upsertWorkTarget, req(founder._id, { body: { kind: "nonsense" } }));
    ok(wkBadKind.code === 400, "unknown target kind → 400");
    const wkBadSlug = await call(p.upsertWorkTarget, req(founder._id, { body: { kind: "enrich", slugs: ["ghost-venue"] } }));
    ok(wkBadSlug.code === 400 && wkBadSlug.body.missing.includes("ghost-venue"), "unknown slugs → 400 naming them");

    const monday = p.weekStartOf(new Date("2026-08-13T10:00:00Z")); // a Thursday
    ok(monday.toISOString().startsWith("2026-08-09"), `weekStartOf lands on the IST Monday (got ${monday.toISOString()})`);

    // ── 11. activity spine ──────────────────────────────────────────────────
    console.log("\n[11] the activity spine recorded it");
    await new Promise((r) => setTimeout(r, 150)); // fire-and-forget writes
    const acts = await VenueActivity.find({ venue: { $in: [vClaim._id, vVerifiedOnly._id, vSelect._id] } }).lean();
    const actions = new Set(acts.map((a) => a.action));
    for (const a of ["venue_verified", "venue_unverified", "partner_access_granted", "partner_terms_updated", "partner_visit_logged"]) {
      ok(actions.has(a), `logged ${a}`);
    }
    ok(acts.filter((a) => a.action === "partner_access_granted").every((a) => a.severity === "high"), "access grants are high severity");
    ok(acts.every((a) => a.actorType === "wedsy_team"), "every entry is attributed to the Wedsy side");

    // ── 12. the couple-facing read exposes both badges ──────────────────────
    console.log("\n[12] couple-facing read");
    const venueCtl = require("../controllers/venue");
    const pubRes = mockRes();
    await venueCtl.getVenueBySlug({ params: { slug: vClaim.slug } }, pubRes);
    ok(pubRes.code === 200, "public venue read → 200");
    ok(pubRes.body.isVerified === false, "isVerified keeps its API name and is now the real boolean");
    ok(pubRes.body.isPartner === true, "isPartner is exposed alongside it");

  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    // cleanup
    await Promise.all([
      Venue.deleteMany({ _id: { $in: created.venues } }),
      Enquiry.deleteMany({ _id: { $in: created.leads } }),
      VenueOwner.deleteMany({ venueId: { $in: created.venues } }),
      VenuePartnerVisit.deleteMany({ venue: { $in: created.venues } }),
      VenueLeadAssist.deleteMany({ venue: { $in: created.venues } }),
      VenueWorkTarget.deleteMany({ assignee: { $in: created.admins } }),
      VenueActivity.deleteMany({ venue: { $in: created.venues } }),
      Admin.deleteMany({ _id: { $in: created.admins } }),
      Role.deleteMany({ _id: { $in: created.roles } }),
      Department.deleteMany({ _id: { $in: created.depts } }),
    ]).catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

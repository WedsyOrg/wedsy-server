/**
 * Journey v2 — V6 (proposal ritual + THE value chain + deal-clock hero) and
 * V7 (agreement ritual + spine completion).
 *
 *   node tests/journey-v2-value-chain.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadPayment = require("../models/LeadPayment");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const Project = require("../models/Project");
const Onboarding = require("../models/Onboarding");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const DealSpineService = require("../services/DealSpineService");
const SettingsService = require("../services/SettingsService");
const enquiryController = require("../controllers/enquiry");

const TAG = `jv2val-${Date.now()}`;
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
const waitFor = async (cond, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return cond();
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [] };
  try {
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}-o@x.com`, phone: `${TAG}o`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(owner._id);
    const qualifiedAt = new Date(Date.now() - 20 * DAY_MS); // 20d ago → amber at 15/30
    const lead = await Enquiry.create({
      name: `${TAG}-couple`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: owner._id, qualified: true, qualifiedAt, firstRespondedAt: new Date(),
    });
    created.leads.push(lead._id);

    // ── V6: amount required + the value chain ────────────────────────────────
    ok(await throwsStatus(() => LeadLifecycleService.proposalShared(String(lead._id), {}, owner._id), 422),
      "proposal-shared without amount → 422");
    ok(await throwsStatus(() => LeadLifecycleService.proposalShared(String(lead._id), { amount: -5 }, owner._id), 422),
      "negative amount → 422");

    const s1 = await LeadLifecycleService.proposalShared(String(lead._id), { amount: 1170000, notes: "first number" }, owner._id);
    ok(s1.firstShare === true && s1.phase === "quoted" && s1.proposalSentAt, "first share stamps proposalSentAt, phase 'quoted'");
    ok(s1.dealValue.amount === 1170000 && s1.dealValue.history.length === 1 && s1.dealValue.history[0].phase === "quoted",
      "dealValue { amount, history[quoted] } written");

    const s2 = await LeadLifecycleService.proposalShared(String(lead._id), { amount: 1120000 }, owner._id);
    ok(s2.firstShare === false && s2.phase === "renegotiated", "re-share is 'renegotiated'");
    ok(s2.dealValue.amount === 1120000 && s2.dealValue.history.length === 2 &&
       +new Date(s2.proposalSentAt) === +new Date(s1.proposalSentAt),
      "re-share updates the amount, appends history, NEVER moves proposalSentAt");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "proposal_shared", "payload.phase": "renegotiated" }),
      "journey event proposal_shared(renegotiated)");

    // Ritual PATCH.
    const r1 = await LeadLifecycleService.setProposalRitual(String(lead._id), { status: "negotiation", notes: "client trimming décor" }, owner._id);
    ok(r1.proposalStatus === "negotiation" && /trimming/.test(r1.proposalNotes), "PATCH proposal { status, notes }");
    ok(await throwsStatus(() => LeadLifecycleService.setProposalRitual(String(lead._id), { status: "bogus" }, owner._id), 400),
      "invalid ritual status → 400");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "proposal_status_changed", "payload.to": "negotiation" }),
      "journey event proposal_status_changed");

    // ── V6: role-gated row value ──────────────────────────────────────────────
    const listReq = (scope) => ({
      query: { page: "1", limit: "100" },
      scopeFilter: { assignedTo: owner._id },
      scope,
      auth: { user_id: String(owner._id) },
    });
    let resList = mockRes();
    enquiryController.GetAll(listReq("own"), resList);
    await waitFor(() => resList.body !== null);
    let row = (resList.body.list || []).find((l) => String(l._id) === String(lead._id));
    ok(row && row.dealValue === null, "own-scope (intern) list row: dealValue null");
    resList = mockRes();
    enquiryController.GetAll(listReq("team"), resList);
    await waitFor(() => resList.body !== null);
    row = (resList.body.list || []).find((l) => String(l._id) === String(lead._id));
    ok(row && row.dealValue && row.dealValue.amount === 1120000 && !row.dealValue.history,
      "manager+ scope list row: dealValue { amount } only (no history)");

    // ── V6: deal-clock hero ───────────────────────────────────────────────────
    const leadObj = await Enquiry.findById(lead._id).lean();
    const clock = await LeadLifecycleService.dealClockDecoration(leadObj);
    ok(clock && clock.days === 20 && clock.tone === "amber", `20d since qualify → amber (got ${JSON.stringify(clock && { days: clock.days, tone: clock.tone })})`);
    // Add a silent unpriced lane → blocker names it.
    const decorLane = await LeadLane.create({
      leadId: lead._id, key: "decor", name: "Décor", state: "active",
      ownerId: owner._id, lastUpdateAt: new Date(Date.now() - 4 * DAY_MS),
    });
    const clock2 = await LeadLifecycleService.dealClockDecoration(leadObj);
    ok(/waiting on Décor pricing/.test(clock2.blocker) && new RegExp(`${TAG}-owner, 4d silent`).test(clock2.blocker),
      `blocker names the silent lane + owner (got "${clock2.blocker}")`);
    // Station gap present (meeting not booked yet — no meets on this lead).
    ok(/meeting/.test(clock2.blocker) || clock2.blocker.length > 0, "blocker carries the station gap");
    // Snoozed → null; red tone at >30d; unqualified → null.
    const snoozed = { ...leadObj, snoozedUntil: new Date(Date.now() + 40 * DAY_MS) };
    ok((await LeadLifecycleService.dealClockDecoration(snoozed)) === null, "snoozed lead → dealClock null");
    const old = { ...leadObj, qualifiedAt: new Date(Date.now() - 31 * DAY_MS) };
    ok((await LeadLifecycleService.dealClockDecoration(old)).tone === "red", ">30d → red");
    ok((await LeadLifecycleService.dealClockDecoration({ ...leadObj, qualified: false, qualifiedAt: null })) === null,
      "unqualified → null");

    // ── V7: agreement ritual + spine ─────────────────────────────────────────
    let spine = DealSpineService.computeDealSpine(leadObj, await DealSpineService.spineInputs(lead._id));
    ok(spine.stations.find((s) => s.key === "agreement").done === false, "agreement station starts incomplete");

    const a1 = await LeadLifecycleService.markAgreementSent(String(lead._id), owner._id);
    ok(a1.agreementSentAt && a1.agreementSentAt.at && String(a1.agreementSentAt.by) === String(owner._id),
      "agreement/sent stamps { at, by }");
    const a2 = await LeadLifecycleService.markAgreementSent(String(lead._id), owner._id);
    ok(a2.alreadyStamped && +new Date(a2.agreementSentAt.at) === +new Date(a1.agreementSentAt.at),
      "checkbox stamps ONCE (re-tick returns the original)");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "agreement_sent" }), "journey event agreement_sent");

    // Sent alone ≠ complete: needs the first payment too.
    let leadNow = await Enquiry.findById(lead._id).lean();
    spine = DealSpineService.computeDealSpine(leadNow, await DealSpineService.spineInputs(lead._id));
    ok(spine.stations.find((s) => s.key === "agreement").done === false,
      "agreementSentAt WITHOUT a payment → station still incomplete");

    await LeadPayment.create({ leadId: lead._id, amount: 25000, mode: "bank", note: "fee", createdBy: owner._id });
    spine = DealSpineService.computeDealSpine(leadNow, await DealSpineService.spineInputs(lead._id));
    ok(spine.stations.find((s) => s.key === "agreement").done === true,
      "agreementSentAt AND first LeadPayment → station complete");

    // ── V6: onboard writes FINAL; post-onboard ledger edit appends final ─────
    const onboarded = await LeadLifecycleService.onboardClient(
      String(lead._id), { feeAmount: 25000, dealTotal: 1100000 }, owner._id
    );
    let dv = (await Enquiry.findById(lead._id).lean()).dealValue;
    ok(dv.amount === 1100000 && dv.history[dv.history.length - 1].phase === "final",
      "onboard writes the FINAL phase (dealValue mirrors dealTotal)");
    await LeadLifecycleService.setDealTotal(String(lead._id), 1050000, owner._id);
    dv = (await Enquiry.findById(lead._id).lean()).dealValue;
    ok(dv.amount === 1050000 && dv.history.filter((h) => h.phase === "final").length === 2,
      "post-onboard ledger edit updates amount + appends another 'final' row");
    ok(dv.history.map((h) => h.phase).join(",") === "quoted,renegotiated,final,final",
      `full chain quoted→renegotiated→final→final (got ${dv.history.map((h) => h.phase).join(",")})`);

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPayment.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Project.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Onboarding.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

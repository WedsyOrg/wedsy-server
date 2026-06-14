const Config = require("../models/Config");
const OnboardingService = require("../services/OnboardingService");
const SettingsService = require("../services/SettingsService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message || "Server error" });

// GET /onboarding/milestones — current milestone settings (defaults when unset).
// Readable by any admin (operational — payment links + onboard read it).
const GetMilestones = async (req, res) => {
  try {
    res.status(200).json(await OnboardingService.getMilestoneConfig());
  } catch (error) {
    respond(res, error);
  }
};

// PUT /onboarding/milestones — founder-editable (settings_onboarding:edit:all).
// Reuses the /config {code,data} storage under code "OnboardingMilestones".
// All amounts in RUPEES.
const PutMilestones = async (req, res) => {
  try {
    const { onboardingFee, advancePercent, balanceDaysBeforeEvent } = req.body || {};
    const num = (v, lo, hi, label) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        throw Object.assign(new Error(`${label} must be a number between ${lo} and ${hi}`), { status: 400 });
      }
      return n;
    };
    const data = {
      onboardingFee: num(onboardingFee, 0, 10000000, "onboardingFee"),
      advancePercent: num(advancePercent, 1, 100, "advancePercent"),
      balanceDaysBeforeEvent: num(balanceDaysBeforeEvent, 0, 365, "balanceDaysBeforeEvent"),
    };
    await Config.findOneAndUpdate(
      { code: OnboardingService.MILESTONE_CODE },
      { $set: { code: OnboardingService.MILESTONE_CODE, data } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ message: "success", data });
  } catch (error) {
    respond(res, error);
  }
};

// GET /onboarding/milestones/preview?total=NNN — compute the three milestones
// for a given total (rupees), so the cockpit/onboard UI can show the breakdown.
const PreviewMilestones = async (req, res) => {
  try {
    const cfg = await OnboardingService.getMilestoneConfig();
    res.status(200).json(OnboardingService.computeMilestones(req.query.total, cfg));
  } catch (error) {
    respond(res, error);
  }
};

// GET /onboarding/agreement — the agreement text + version for the onboard flow.
// CheckLogin so the CLIENT (wedsy-user) can read it (the admin-only
// /settings/public can't be reached by client tokens).
const GetAgreementText = async (req, res) => {
  try {
    const [terms, version] = await Promise.all([
      SettingsService.get("agreement.terms"),
      SettingsService.get("agreement.version"),
    ]);
    res.status(200).json({ terms, version });
  } catch (error) {
    respond(res, error);
  }
};

// POST /onboarding/agreement — client (or OS on their behalf) accepts the terms.
// Body: { leadId, eventId?, acceptedName }. Records acceptance + journey.
const AcceptAgreement = async (req, res) => {
  try {
    const { leadId, eventId, acceptedName } = req.body || {};
    const actorId = req.auth && req.auth.isAdmin ? req.auth.user_id : null;
    const doc = await OnboardingService.acceptAgreement({ leadId, eventId, acceptedName, actorId });
    res.status(200).json({ message: "success", agreement: doc.agreement });
  } catch (error) {
    respond(res, error);
  }
};

// POST /onboarding/start — Revenue Head onboards a client (leads:onboard).
// Body: { leadId, eventId? }. Locks the client dashboard, snapshots milestones.
const StartOnboarding = async (req, res) => {
  try {
    const { leadId, eventId } = req.body || {};
    const result = await OnboardingService.startOnboarding({ leadId, eventId, actorId: req.auth.user_id });
    res.status(200).json({ message: "success", ...result });
  } catch (error) {
    respond(res, error);
  }
};

// GET /onboarding/state?eventId= — CLIENT-facing lock/onboarded flags (wedsy-user).
const ClientState = async (req, res) => {
  try {
    const { eventId } = req.query;
    if (!eventId) return res.status(400).json({ message: "eventId is required" });
    res.status(200).json(await OnboardingService.clientState(eventId, req.auth.user_id, !!(req.auth && req.auth.isAdmin)));
  } catch (error) {
    respond(res, error);
  }
};

// POST /onboarding/payment-link — generate a Razorpay link for a milestone
// (dormant-safe). Body: { leadId, eventId, milestone }.
const CreatePaymentLink = async (req, res) => {
  try {
    const { leadId, eventId, milestone } = req.body || {};
    res.status(200).json(await OnboardingService.createMilestonePaymentLink({ leadId, eventId, milestone, actorId: req.auth.user_id }));
  } catch (error) {
    respond(res, error);
  }
};

// POST /onboarding/payment/offline — record an offline payment with proof.
// Body: { leadId, eventId, milestone, amountRupees, method, txnId?, paidOn?, notes?, proofUrl? }.
const RecordOfflinePayment = async (req, res) => {
  try {
    const b = req.body || {};
    const out = await OnboardingService.recordOfflinePayment({ ...b, actorId: req.auth.user_id });
    res.status(200).json({ message: "success", ...out });
  } catch (error) {
    respond(res, error);
  }
};

// POST /onboarding/payment/:paymentId/confirm — mark an online milestone paid
// (the verification seam; e.g. called after a Razorpay callback).
const ConfirmOnlinePayment = async (req, res) => {
  try {
    res.status(200).json(await OnboardingService.confirmOnlineMilestonePaid({ paymentId: req.params.paymentId, actorId: req.auth.user_id }));
  } catch (error) {
    respond(res, error);
  }
};

// GET /onboarding?leadId=&eventId= — onboarding status (OS).
const GetStatus = async (req, res) => {
  try {
    const { leadId, eventId } = req.query;
    if (!leadId) return res.status(400).json({ message: "leadId is required" });
    const doc = await OnboardingService.getOnboarding(leadId, eventId || null);
    res.status(200).json({ onboarding: doc || null });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { GetMilestones, PutMilestones, PreviewMilestones, GetAgreementText, AcceptAgreement, GetStatus, StartOnboarding, ClientState, CreatePaymentLink, RecordOfflinePayment, ConfirmOnlinePayment };

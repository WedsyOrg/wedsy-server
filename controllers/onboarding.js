const Config = require("../models/Config");
const OnboardingService = require("../services/OnboardingService");

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

module.exports = { GetMilestones, PutMilestones, PreviewMilestones };

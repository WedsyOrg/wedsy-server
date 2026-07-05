/**
 * controllers/venueOnboarding.js — public "list your venue" lead capture.
 * POST /venues/onboarding-requests (public, rate-limited). Hostile-input validated.
 */
const VenueOnboardingRequest = require("../models/VenueOnboardingRequest");
const { reqStr, optStr, MAXLEN } = require("../utils/venueInput");
const { notifyOnboardingRequest } = require("../utils/venueOpsAlert");

const createOnboardingRequest = async (req, res) => {
  try {
    const { name, venueName, city, phone } = req.body || {};
    const nameV = reqStr(name, "name", MAXLEN.name);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const venueV = reqStr(venueName, "venueName", MAXLEN.name);
    if (!venueV.ok) return res.status(400).json({ message: venueV.message });
    const cityV = optStr(city, "city", 120);
    if (!cityV.ok) return res.status(400).json({ message: cityV.message });
    const phoneDigits = String(phone == null ? "" : phone).replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      return res.status(400).json({ message: "A valid phone number is required" });
    }
    const doc = await VenueOnboardingRequest.create({
      name: nameV.value,
      venueName: venueV.value,
      city: cityV.value,
      phone: String(phone).trim().slice(0, MAXLEN.phone),
      status: "new",
    });
    // Fire-and-forget ops alert — env-gated, log-only by default, and a
    // delivery failure must never affect the 201 we owe the requester.
    notifyOnboardingRequest({ name: doc.name, venueName: doc.venueName, city: doc.city, phone: doc.phone }).catch(() => {});
    // MB-V2 P3 notification mesh (log-only, fire-and-forget; no venue yet).
    require("../utils/venueNotify").notify({
      type: "onboarding_arrived",
      title: `New onboarding request — ${doc.venueName}`,
      body: `${doc.name} · ${doc.city || "—"} · ${doc.phone}`,
      meta: { onboardingId: doc._id },
    });
    return res.status(201).json({ success: true, id: doc._id });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { createOnboardingRequest };

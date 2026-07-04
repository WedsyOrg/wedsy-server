/**
 * controllers/venueContract.js — Phase 3.5 contracts.
 *
 * Lifecycle: generate (draft, seeded from venue.policyDoc + frozen booking
 * specifics) → edit while draft → send (signed short-lived public ack token)
 * → digital acknowledgment by the couple (name + phone matched against the
 * booking) → acknowledged. Generating a new version voids prior
 * non-acknowledged versions.
 *
 * The public ack route is token-addressed (no auth) and rate-limited at the
 * router; it never reveals more than the contract being acknowledged.
 */
const jwt = require("jsonwebtoken");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueContract = require("../models/VenueContract");
const { reqStr, optStr } = require("../utils/venueInput");

const ACK_TTL_HOURS = Number(process.env.CONTRACT_ACK_TTL_HOURS) > 0 ? Number(process.env.CONTRACT_ACK_TTL_HOURS) : 168; // 7 days

async function resolveOwnedVenue(req, res, select = "_id name policies policyDoc") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

// Same read-time migration rules as controllers/venue.js withPolicyDoc.
function effectivePolicyDoc(venue) {
  const pd = venue.policyDoc || {};
  const has = (a) => Array.isArray(a) && a.length > 0;
  if (has(pd.policies) || has(pd.terms) || has(pd.refund)) {
    return { policies: pd.policies || [], terms: pd.terms || [], refund: pd.refund || [] };
  }
  const legacy = venue.policies || {};
  const clean = (...vals) => vals.map((s) => (s == null ? "" : String(s).trim())).filter(Boolean);
  return {
    policies: clean(legacy.otherRestrictions),
    terms: [],
    refund: clean(legacy.cancellation, legacy.refund),
  };
}

function seedSections(venue) {
  const pd = effectivePolicyDoc(venue);
  return [
    { heading: "Venue Policies", clauses: pd.policies },
    { heading: "Terms & Conditions", clauses: pd.terms },
    { heading: "Cancellation & Refund Policy", clauses: pd.refund },
  ].filter((s) => s.clauses.length > 0);
}

function validateSections(input) {
  if (!Array.isArray(input)) return { error: "sections must be an array" };
  if (input.length > 20) return { error: "too many sections (max 20)" };
  const out = [];
  for (const s of input) {
    const headV = reqStr(s && s.heading, "section heading", 200);
    if (!headV.ok) return { error: headV.message };
    const clauses = Array.isArray(s.clauses) ? s.clauses : [];
    if (clauses.length > 100) return { error: "too many clauses in a section (max 100)" };
    const cleaned = clauses.map((c) => String(c == null ? "" : c).trim().slice(0, 2000)).filter(Boolean);
    out.push({ heading: headV.value, clauses: cleaned });
  }
  return { value: out };
}

// POST /venues/:slug/bookings/:bookingId/contracts — leads capability.
// Generates the next version; prior non-acknowledged versions become void.
const generateContract = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id }).lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const prior = await VenueContract.find({ venue: venue._id, booking: booking._id }).sort({ version: -1 }).lean();
    if (prior.some((c) => c.status === "acknowledged")) {
      // An acknowledged contract stays the source of truth; new versions are
      // still allowed (renegotiation) but the old one is never voided.
    }
    const version = prior.length ? (prior[0].version || 1) + 1 : 1;

    const contract = await VenueContract.create({
      venue: venue._id,
      booking: booking._id,
      version,
      sections: seedSections(venue),
      parties: {
        venueName: venue.name || "",
        coupleName: booking.coupleName || "",
        couplePhone: booking.couplePhone || "",
      },
      specifics: {
        days: (booking.days || []).map((d) => ({ date: d.date, eventType: d.eventType || "", guestCount: d.guestCount || 0 })),
        totalValue: Number(booking.totalValue) || 0,
        paymentSchedule: (booking.paymentSchedule || []).map((m) => ({ label: m.label || "", dueDate: m.dueDate, amount: Number(m.amount) || 0 })),
      },
      status: "draft",
    });

    await VenueContract.updateMany(
      { venue: venue._id, booking: booking._id, _id: { $ne: contract._id }, status: { $in: ["draft", "sent"] } },
      { $set: { status: "void" } }
    );

    return res.status(201).json({ contract });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/bookings/:bookingId/contracts — open read.
const listContracts = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id");
    if (!venue) return;
    const contracts = await VenueContract.find({ venue: venue._id, booking: req.params.bookingId })
      .sort({ version: -1 })
      .lean();
    return res.status(200).json({ contracts });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/contracts/:contractId — leads capability, draft only.
const updateContract = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id");
    if (!venue) return;
    const contract = await VenueContract.findOne({ _id: req.params.contractId, venue: venue._id });
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    if (contract.status !== "draft") return res.status(409).json({ message: `Only drafts can be edited (status: ${contract.status})` });
    if (req.body && req.body.sections !== undefined) {
      const v = validateSections(req.body.sections);
      if (v.error) return res.status(400).json({ message: v.error });
      contract.sections = v.value;
    }
    await contract.save();
    return res.status(200).json({ contract });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/contracts/:contractId/send — leads capability.
// draft|sent → sent (re-send regenerates the token); returns the public ack path.
const sendContract = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id");
    if (!venue) return;
    const contract = await VenueContract.findOne({ _id: req.params.contractId, venue: venue._id });
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    if (!["draft", "sent"].includes(contract.status)) {
      return res.status(409).json({ message: `Cannot send from status "${contract.status}"` });
    }
    if (contract.status === "draft") {
      contract.status = "sent";
      contract.sentAt = new Date();
      await contract.save();
    }
    const token = jwt.sign(
      { type: "venue_contract_ack", contractId: String(contract._id) },
      process.env.JWT_SECRET,
      { expiresIn: `${ACK_TTL_HOURS}h` }
    );
    return res.status(200).json({ contract, ackToken: token, ackPath: `/ack?token=${token}` });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

function verifyAckToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || payload.type !== "venue_contract_ack" || !payload.contractId) return null;
    return payload;
  } catch {
    return null;
  }
}

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

// GET /venues/contract-ack/:token — PUBLIC (rate-limited at the router).
const getAckContract = async (req, res) => {
  try {
    const payload = verifyAckToken(req.params.token);
    if (!payload) return res.status(401).json({ message: "This link is invalid or has expired" });
    const contract = await VenueContract.findById(payload.contractId)
      .select("sections parties specifics status version sentAt acknowledgedAt acknowledgmentName")
      .lean();
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    if (!["sent", "acknowledged"].includes(contract.status)) {
      return res.status(409).json({ message: "This contract is no longer open for acknowledgment" });
    }
    // Mask the phone — the public page never reveals it.
    const masked = contract.parties && contract.parties.couplePhone
      ? contract.parties.couplePhone.replace(/\d(?=\d{3})/g, "•")
      : "";
    return res.status(200).json({
      contract: { ...contract, parties: { ...contract.parties, couplePhone: masked } },
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/contract-ack/:token — PUBLIC (rate-limited at the router).
// Body: { name, phone } — phone must match the booking couple's phone.
const acknowledgeContract = async (req, res) => {
  try {
    const payload = verifyAckToken(req.params.token);
    if (!payload) return res.status(401).json({ message: "This link is invalid or has expired" });
    const contract = await VenueContract.findById(payload.contractId);
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    if (contract.status === "acknowledged") {
      return res.status(409).json({ message: "This contract has already been acknowledged" });
    }
    if (contract.status !== "sent") {
      return res.status(409).json({ message: "This contract is no longer open for acknowledgment" });
    }

    const nameV = reqStr((req.body || {}).name, "name", 200);
    if (!nameV.ok) return res.status(400).json({ message: nameV.message });
    const phoneV = optStr((req.body || {}).phone, "phone", 30);
    if (!phoneV.ok) return res.status(400).json({ message: phoneV.message });
    const given = last10(phoneV.value);
    const expected = last10(contract.parties && contract.parties.couplePhone);
    if (!given || given.length < 10) return res.status(400).json({ message: "A valid phone number is required" });
    if (!expected) return res.status(409).json({ message: "This booking has no phone on record — contact the venue" });
    if (given !== expected) return res.status(403).json({ message: "The phone number does not match this booking" });

    contract.status = "acknowledged";
    contract.acknowledgedAt = new Date();
    contract.acknowledgmentName = nameV.value;
    contract.acknowledgmentPhone = phoneV.value;
    await contract.save();
    return res.status(200).json({ success: true, acknowledgedAt: contract.acknowledgedAt });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/contracts/:contractId/pdf — open read.
const contractPdf = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id name address formattedAddress contact phone email logo");
    if (!venue) return;
    const contract = await VenueContract.findOne({ _id: req.params.contractId, venue: venue._id }).lean();
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    const { streamContractPdf } = require("../utils/venuePdf");
    await streamContractPdf(res, { venue, contract });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  generateContract,
  listContracts,
  updateContract,
  sendContract,
  contractPdf,
  getAckContract,
  acknowledgeContract,
};

// Slice B5a — the lead MONEY LEDGER. Record/list payments against a lead and
// compute the running balance against Enquiry.dealTotal. Distinct from the
// consumer-side Payment model (wedsy-user checkout) by design.
const mongoose = require("mongoose");
const LeadPayment = require("../models/LeadPayment");
const Enquiry = require("../models/Enquiry");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const LeadLaneService = require("./LeadLaneService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const MODES = ["cash", "bank", "upi", "razorpay"];

// GET — ledger rows (newest first) + the computed header.
const listForLead = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, { dealTotal: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const list = await LeadPayment.find({ leadId }).sort({ receivedAt: -1 }).lean();
  const received = list.reduce((n, p) => n + (Number(p.amount) || 0), 0);
  const total = lead.dealTotal != null ? Number(lead.dealTotal) : null;
  return {
    list,
    total,
    received,
    balance: total != null ? Math.max(0, total - received) : null,
  };
};

// POST — record one payment. Echoes into the lead_comms lane + the journey and
// stamps the activity spine. NO win/broadcast side effects here.
const record = async (leadId, { amount, mode, proofUrl, receivedAt, note, projectId } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw err(400, "amount must be a positive number");
  const cleanMode = mode === undefined || mode === "" ? "bank" : mode;
  if (!MODES.includes(cleanMode)) throw err(400, `mode must be one of: ${MODES.join(", ")}`);
  let at = new Date();
  if (receivedAt !== undefined) {
    at = new Date(receivedAt);
    if (Number.isNaN(at.getTime())) throw err(400, "Invalid receivedAt");
  }
  const lead = await Enquiry.findById(leadId, { _id: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const payment = await LeadPayment.create({
    leadId,
    projectId: projectId && isId(projectId) ? projectId : null,
    amount: amt,
    mode: cleanMode,
    proofUrl: String(proofUrl || "").slice(0, 1000),
    receivedAt: at,
    recordedBy: actorId || null,
    note: String(note || "").slice(0, 1000),
  });

  await LeadInternalEventService.record({
    leadId,
    type: "payment_recorded",
    actorId: actorId || null,
    payload: { paymentId: String(payment._id), amount: amt, mode: cleanMode },
  });
  await LeadLaneService.autoEntry(leadId, "lead_comms", "payment", `Payment received · ${cleanMode.toUpperCase()}`);
  await EnquiryRepository.touchLastActivity(leadId);
  return payment.toObject();
};

// DELETE — founder tier only (route-gated leads:delete:all).
const remove = async (leadId, paymentId) => {
  if (!isId(leadId) || !isId(paymentId)) throw err(400, "Invalid id");
  const gone = await LeadPayment.findOneAndDelete({ _id: paymentId, leadId }).lean();
  if (!gone) throw err(404, "Payment not found");
  return { ok: true };
};

module.exports = { listForLead, record, remove, MODES };

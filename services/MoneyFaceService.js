// L3 — THE MONEY FACE READ. One composed endpoint the FE renders alone:
// dealValue · received/balance · milestone schedule · ledger · documents.
// Documents note: this repo persists NO document records — invoices/agreements
// generate on the fly (BillingDocService PDF endpoints). The documents[] list
// therefore points at the GENERATION endpoints: the agreement (always
// available post-share) and one invoice per payment that has an invoiceNumber
// stamped (the stamp is the only durable trace an invoice exists). Quote PDFs
// / statements / receipts have no storage today — omitted.
// walletApplied: no wallet concept exists in this repo → always null.
// discounts: no discount records exist → always [].
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadPayment = require("../models/LeadPayment");
const PaymentMilestoneService = require("./PaymentMilestoneService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const moneyFace = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, { dealValue: 1, dealTotal: 1, agreementSentAt: 1, proposalSentAt: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");

  const [payments, schedule] = await Promise.all([
    LeadPayment.find({ leadId }).sort({ receivedAt: -1 }).lean(),
    PaymentMilestoneService.listForLead(leadId),
  ]);

  const recorderIds = [...new Set(payments.map((p) => String(p.recordedBy || "")).filter(Boolean))];
  const recorders = recorderIds.length
    ? await Admin.find({ _id: { $in: recorderIds } }, { name: 1 }).lean()
    : [];
  const nameOf = new Map(recorders.map((a) => [String(a._id), a.name]));

  const received = payments.reduce((n, p) => n + (Number(p.amount) || 0), 0);
  const total = lead.dealTotal != null ? Number(lead.dealTotal) : null;

  const ledger = payments.map((p) => ({
    _id: String(p._id),
    amount: p.amount,
    mode: p.mode,
    proofUrl: p.proofUrl || "",
    receivedAt: p.receivedAt,
    recordedBy: p.recordedBy ? String(p.recordedBy) : null,
    recordedByName: p.recordedBy ? nameOf.get(String(p.recordedBy)) || "—" : null,
    note: p.note || "",
    invoiceNumber: p.invoiceNumber || "",
    milestoneId: p.milestoneId ? String(p.milestoneId) : null,
    // No admin recorded it → it arrived through the couple's app/gateway.
    viaCoupleApp: !p.recordedBy,
  }));

  const documents = [];
  if (lead.agreementSentAt && lead.agreementSentAt.at) {
    documents.push({
      type: "agreement",
      name: "Booking agreement",
      url: `/enquiry/${leadId}/agreement.pdf`,
      generatedAt: lead.agreementSentAt.at,
      auto: true,
    });
  }
  for (const p of payments) {
    if (!p.invoiceNumber) continue;
    documents.push({
      type: "invoice",
      name: p.invoiceNumber,
      url: `/enquiry/${leadId}/payments/${p._id}/invoice.pdf`,
      generatedAt: p.updatedAt || p.receivedAt,
      auto: true,
    });
  }

  return {
    dealValue: lead.dealValue && lead.dealValue.amount != null
      ? { amount: lead.dealValue.amount, history: lead.dealValue.history || [] }
      : { amount: null, history: [] },
    total,
    received,
    balance: total != null ? Math.max(0, total - received) : null,
    schedule,
    ledger,
    walletApplied: null, // no wallet concept in this repo (reported)
    documents,
    discounts: [], // no discount records exist (reported)
  };
};

module.exports = { moneyFace };

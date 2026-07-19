// L2 — PAYMENT MILESTONES. CRUD + the derived status compute: each milestone's
// paidAmount = Σ LeadPayment rows tagged with its id; status = paid (covered)
// / partial (some money) / overdue (dueAt past, not paid) / pending. Nothing
// stored — old leads with no schedule are simply an empty list.
const mongoose = require("mongoose");
const PaymentMilestone = require("../models/PaymentMilestone");
const LeadPayment = require("../models/LeadPayment");
const Enquiry = require("../models/Enquiry");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

// Batched decorate: milestones + ONE payment aggregation.
const decorate = async (leadId, milestones, now = new Date()) => {
  if (!milestones.length) return [];
  const sums = await LeadPayment.aggregate([
    { $match: { leadId: new mongoose.Types.ObjectId(String(leadId)), milestoneId: { $ne: null } } },
    { $group: { _id: "$milestoneId", paid: { $sum: "$amount" } } },
  ]);
  const paidBy = new Map(sums.map((s) => [String(s._id), s.paid]));
  return milestones.map((m) => {
    const paidAmount = paidBy.get(String(m._id)) || 0;
    const covered = paidAmount >= (m.amount || 0) && (m.amount || 0) > 0;
    const status = covered
      ? "paid"
      : m.dueAt && +new Date(m.dueAt) < +now
        ? "overdue"
        : paidAmount > 0
          ? "partial"
          : "pending";
    return { ...m, paidAmount, status };
  });
};

const listForLead = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const rows = await PaymentMilestone.find({ leadId }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  return await decorate(leadId, rows);
};

const create = async (leadId, { name, amount, dueAt, sortOrder } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const lead = await Enquiry.findById(leadId, { _id: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const cleanName = String(name || "").trim();
  if (!cleanName) throw err(400, "A milestone needs a name.");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw err(400, "amount must be a positive number");
  let due = null;
  if (dueAt != null && dueAt !== "") {
    due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw err(400, "Invalid dueAt");
  }
  let order = Number(sortOrder);
  if (!Number.isFinite(order)) {
    const last = await PaymentMilestone.findOne({ leadId }).sort({ sortOrder: -1 }).lean();
    order = last ? last.sortOrder + 1 : 0;
  }
  const doc = await PaymentMilestone.create({
    leadId, name: cleanName.slice(0, 200), amount: amt, dueAt: due, sortOrder: order, createdBy: actorId || null,
  });
  return (await decorate(leadId, [doc.toObject()]))[0];
};

// Whitelisted patch: name · amount · dueAt · sortOrder — nothing else.
const patch = async (leadId, milestoneId, fields = {}) => {
  if (!isId(leadId) || !isId(milestoneId)) throw err(400, "Invalid id");
  const doc = await PaymentMilestone.findOne({ _id: milestoneId, leadId });
  if (!doc) throw err(404, "Milestone not found");
  const set = {};
  if (fields.name !== undefined) {
    const n = String(fields.name || "").trim();
    if (!n) throw err(400, "A milestone needs a name.");
    set.name = n.slice(0, 200);
  }
  if (fields.amount !== undefined) {
    const a = Number(fields.amount);
    if (!Number.isFinite(a) || a <= 0) throw err(400, "amount must be a positive number");
    set.amount = a;
  }
  if (fields.dueAt !== undefined) {
    if (fields.dueAt === null || fields.dueAt === "") set.dueAt = null;
    else {
      const d = new Date(fields.dueAt);
      if (Number.isNaN(d.getTime())) throw err(400, "Invalid dueAt");
      set.dueAt = d;
    }
  }
  if (fields.sortOrder !== undefined) {
    const o = Number(fields.sortOrder);
    if (!Number.isFinite(o)) throw err(400, "sortOrder must be a number");
    set.sortOrder = o;
  }
  if (!Object.keys(set).length) throw err(400, "Nothing to update.");
  await PaymentMilestone.updateOne({ _id: doc._id }, { $set: set });
  const fresh = await PaymentMilestone.findById(doc._id).lean();
  return (await decorate(leadId, [fresh]))[0];
};

const remove = async (leadId, milestoneId) => {
  if (!isId(leadId) || !isId(milestoneId)) throw err(400, "Invalid id");
  const gone = await PaymentMilestone.findOneAndDelete({ _id: milestoneId, leadId }).lean();
  if (!gone) throw err(404, "Milestone not found");
  // Untag payments that pointed here (whitelisted, additive-safe).
  await LeadPayment.updateMany({ leadId, milestoneId }, { $set: { milestoneId: null } }).catch(() => {});
  return { ok: true };
};

module.exports = { listForLead, create, patch, remove, decorate };

const mongoose = require("mongoose");
const Reimbursement = require("../models/Reimbursement");
const Admin = require("../models/Admin");
const AdminNotificationService = require("./AdminNotificationService");
const { isServiceAccount } = require("../utils/employment");
const { storeReceipt } = require("../utils/receiptStore");

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIDED = ["approved", "partial", "rejected"];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// -- Create a claim. Receipts are attached separately, so a claimant can start
// one on a laptop and photograph the bill on a phone.
const createClaim = async ({ amountClaimed, spentOn, category, note }, actorId) => {
  const admin = await Admin.findById(actorId).lean();
  if (!admin) throw err(404, "Claimant not found");
  // A service account is a login, not a person. It has nothing to reimburse.
  if (isServiceAccount(admin)) throw err(403, "Service accounts cannot file claims");

  const amt = Number(amountClaimed);
  if (!Number.isFinite(amt) || amt <= 0) throw err(400, "amountClaimed must be a positive number");
  if (!DAY_RE.test(String(spentOn || ""))) throw err(400, 'spentOn must be an IST day key "YYYY-MM-DD"');
  if (!Reimbursement.CATEGORIES.includes(category)) {
    throw err(400, `category must be one of ${Reimbursement.CATEGORIES.join(", ")}`);
  }
  const doc = await Reimbursement.create({
    claimant: actorId,
    amountClaimed: round2(amt),
    spentOn,
    category,
    note: String(note || ""),
  });
  return doc.toObject();
};

// The claim a caller is allowed to WRITE to: their own, and only while pending.
const ownPendingClaim = async (claimId, actorId) => {
  if (!isId(claimId)) throw err(400, "Invalid claim id");
  const claim = await Reimbursement.findById(claimId);
  if (!claim) throw err(404, "Claim not found");
  if (String(claim.claimant) !== String(actorId)) {
    throw err(403, "You can only change your own claims");
  }
  if (DECIDED.includes(claim.status)) {
    // The model would refuse the write anyway; this is the readable version of
    // the same rule, so the claimant gets a sentence rather than a 500.
    throw err(409, `This claim is already ${claim.status} — its receipts can no longer change`);
  }
  return claim;
};

// -- Attach a receipt. One file per call: a failed third upload must not lose
// the first two.
const addReceipt = async (claimId, { buffer, filename, declaredMime }, actorId) => {
  const claim = await ownPendingClaim(claimId, actorId);
  const receipt = await storeReceipt({
    buffer,
    filename,
    declaredMime,
    claimId: String(claim._id),
    uploadedBy: actorId,
  });
  claim.attachments.push(receipt);
  await claim.save();
  return claim.toObject();
};

const removeReceipt = async (claimId, url, actorId) => {
  const claim = await ownPendingClaim(claimId, actorId);
  const before = claim.attachments.length;
  claim.attachments = claim.attachments.filter((a) => a.url !== url);
  if (claim.attachments.length === before) throw err(404, "No such receipt on this claim");
  await claim.save();
  // The S3 object is deliberately NOT deleted. Detaching is a claimant tidying
  // up a mistake; destroying the bytes is not something a claim edit should do,
  // and the orphan costs a few kilobytes.
  return claim.toObject();
};

const submit = async (claimId, actorId) => {
  const claim = await ownPendingClaim(claimId, actorId);
  if (!claim.attachments.length) throw err(400, "Attach at least one receipt before submitting");
  const founders = await foundersToNotify();
  await AdminNotificationService.notify(founders, {
    type: "reimbursement_claim",
    title: `${(await Admin.findById(actorId, { name: 1 }).lean()).name} claimed Rs ${claim.amountClaimed}`,
    message: `${claim.category} on ${claim.spentOn} - ${claim.attachments.length} receipt(s)`,
    payload: { claimId: String(claim._id), amountClaimed: claim.amountClaimed },
  });
  return claim.toObject();
};

// Every claim goes to a founder - no approval threshold, by ruling. Holders of
// payroll:approve are who that means in permission terms.
const foundersToNotify = async () => {
  const Role = require("../models/Role");
  const { permissionSatisfies } = require("../middlewares/requirePermission");
  const roles = await Role.find({}, { _id: 1, permissions: 1 }).lean();
  const ids = roles
    .filter((r) => permissionSatisfies(r.permissions || [], "payroll:approve:all").allowed)
    .map((r) => String(r._id));
  if (!ids.length) return [];
  const admins = await Admin.find(
    { $or: [{ roleIds: { $in: ids } }, { roleId: { $in: ids } }], isDisabled: { $ne: true } },
    { _id: 1 }
  ).lean();
  return admins.map((a) => a._id);
};

// -- THE DECISION: three outcomes, founder-only.
//
// BOTH FIGURES ARE PRESERVED. amountApproved is written alongside
// amountClaimed, never over it: the claimed figure is what the person actually
// asked for and is the number they will query later.
const decide = async (claimId, { outcome, amountApproved, reason }, actorId) => {
  if (!isId(claimId)) throw err(400, "Invalid claim id");
  if (!["approve", "partial", "reject"].includes(outcome)) {
    throw err(400, 'outcome must be "approve", "partial" or "reject"');
  }
  const claim = await Reimbursement.findById(claimId);
  if (!claim) throw err(404, "Claim not found");
  if (DECIDED.includes(claim.status)) throw err(409, `This claim is already ${claim.status}`);
  if (String(claim.claimant) === String(actorId)) throw err(403, "You cannot decide your own claim");

  const clean = String(reason || "").trim();
  let status;
  let approved;

  if (outcome === "reject") {
    if (!clean) throw err(400, "A reason is required when you reject a claim");
    status = "rejected";
    approved = 0;
  } else if (outcome === "partial") {
    const amt = Number(amountApproved);
    if (!Number.isFinite(amt) || amt < 0) throw err(400, "amountApproved must be a number >= 0");
    if (amt >= claim.amountClaimed) {
      throw err(400, "A partial approval must be LESS than the amount claimed - use approve for the full amount");
    }
    // Paying less than was asked for is a decision that needs explaining, the
    // same way an overridden price does.
    if (!clean) throw err(400, "A reason is required when you approve a different amount");
    status = "partial";
    approved = round2(amt);
  } else {
    status = "approved";
    approved = claim.amountClaimed;
  }

  // Guarded so two founders deciding at once cannot both write.
  const claimed = await Reimbursement.updateOne(
    { _id: claim._id, status: "pending" },
    { $set: { status, amountApproved: approved, decisionReason: clean, decidedBy: actorId, decidedAt: new Date() } }
  );
  if (!claimed.modifiedCount) throw err(409, "This claim was decided by someone else");

  await AdminNotificationService.notify([claim.claimant], {
    type: "reimbursement_decided",
    title: `Your claim was ${status}`,
    message: status === "partial"
      ? `Rs ${approved} approved of Rs ${claim.amountClaimed} - ${clean}`
      : clean,
    payload: { claimId: String(claim._id), status, amountApproved: approved },
  });
  return (await Reimbursement.findById(claim._id)).toObject();
};

// -- PAYROLL: unpaid approved claims, as ADDITIONS.
//
// Approved claims are money OWED TO the person, not a reversal of anything owed
// BY them, so they are never netted against LOP or a fine. A run picks up every
// approved claim not yet stamped with a run, whenever it was spent - a claim
// approved in September for an August lunch is paid in whichever run finalises
// next, which is what "reimbursed" means to the person waiting for it.
const unpaidApprovedFor = async (adminId) =>
  Reimbursement.find({
    claimant: adminId,
    status: { $in: ["approved", "partial"] },
    paidWithRun: null,
  }).lean();

// Stamped at FINALISE so a claim can never be paid twice. Guarded on
// paidWithRun still being null, so a re-run cannot re-stamp.
const markPaid = async (claimIds, month) => {
  if (!claimIds || !claimIds.length) return { paid: 0 };
  const res = await Reimbursement.updateMany(
    { _id: { $in: claimIds }, paidWithRun: null },
    { $set: { paidWithRun: month } }
  );
  return { paid: res.modifiedCount || 0 };
};

const listMine = async (adminId) =>
  Reimbursement.find({ claimant: adminId }).sort({ createdAt: -1 }).lean();

const listAll = async (scopeFilter = {}, { status } = {}) => {
  const q = { ...scopeFilter };
  if (status) q.status = status;
  return Reimbursement.find(q).sort({ createdAt: -1 }).populate("claimant", "name").populate("decidedBy", "name").lean();
};

module.exports = {
  createClaim, addReceipt, removeReceipt, submit, decide,
  unpaidApprovedFor, markPaid, listMine, listAll, foundersToNotify,
};

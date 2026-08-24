const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const { employedOn } = require("../utils/employment");

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// -- OFFBOARDING -------------------------------------------------------------
//
// An exit writes THREE things, and they answer three different questions:
//
//   meta.exitedAt   WHEN employment ended (the last working day, inclusive).
//                   The authoritative fact. Payroll asks a date, not a flag.
//   status:"exited" THAT it ended. The fast index — dozens of selectors already
//                   filter status:"active", so this drops a leaver out of
//                   assignment, pools and notification targets everywhere at
//                   once without patching each one.
//   isDisabled      ACCESS. A separate question deliberately: someone can be
//                   locked out while still employed (an investigation), and a
//                   leaver's employment record must outlive their login. The
//                   exit sets both, but neither implies the other.
//
// NOTHING IS DELETED. Leads, enquiries, attendance, leave and payroll rows all
// keep pointing at the person. A payroll system that erases people is one you
// cannot audit — and the months they worked must still compute.

const directReportsOf = async (adminId) =>
  Admin.find({ reportingManagerId: adminId, status: { $ne: "exited" } }, { name: 1, email: 1 }).lean();

// Who would break if this person left today. Callable on its own so a UI can
// warn BEFORE the founder commits to a date.
const exitImpact = async (adminId) => {
  if (!isId(adminId)) throw err(400, "Invalid admin id");
  const admin = await Admin.findById(adminId, { name: 1, status: 1, meta: 1, isDisabled: 1, joinedAt: 1 }).lean();
  if (!admin) throw err(404, "Admin not found");
  const reports = await directReportsOf(adminId);
  return {
    adminId,
    name: admin.name,
    alreadyExited: admin.status === "exited" || !!(admin.meta && admin.meta.exitedAt),
    directReports: reports.map((r) => ({ adminId: r._id, name: r.name })),
    blocked: reports.length > 0,
  };
};

// -- RECORD AN EXIT ----------------------------------------------------------
// Refuses while the person still has direct reports, unless reassignTo is
// supplied. The org chart must never break silently: today's leavers happen to
// have nobody under them, but the next one will.
const recordExit = async ({ adminId, exitedAt, reason, reassignTo }, actorId) => {
  if (!isId(adminId)) throw err(400, "Invalid admin id");
  if (!DAY_RE.test(String(exitedAt || ""))) {
    throw err(400, 'exitedAt must be the last working day as an IST day key "YYYY-MM-DD"');
  }
  const admin = await Admin.findById(adminId);
  if (!admin) throw err(404, "Admin not found");
  if (admin.status === "exited") throw err(409, `${admin.name} is already recorded as exited`);
  if (admin.joinedAt && dayKey(admin.joinedAt) > exitedAt) {
    throw err(400, `${admin.name} joined on ${dayKey(admin.joinedAt)} — an exit cannot precede it`);
  }

  const reports = await directReportsOf(adminId);
  if (reports.length) {
    if (!reassignTo) {
      throw err(
        409,
        `${admin.name} still has ${reports.length} direct report(s): ${reports.map((r) => r.name).join(", ")}. ` +
          "Supply reassignTo, or move them first — an exit must not silently orphan the org chart.",
        { code: "HAS_DIRECT_REPORTS", directReports: reports.map((r) => ({ adminId: r._id, name: r.name })) }
      );
    }
    if (!isId(reassignTo)) throw err(400, "Invalid reassignTo id");
    if (String(reassignTo) === String(adminId)) throw err(400, "Cannot reassign reports to the person leaving");
    const newMgr = await Admin.findById(reassignTo, { name: 1, status: 1 }).lean();
    if (!newMgr) throw err(404, "reassignTo does not match any admin");
    if (newMgr.status === "exited") throw err(400, `${newMgr.name} has also left — pick a manager who is still here`);
    await Admin.updateMany(
      { reportingManagerId: adminId },
      { $set: { reportingManagerId: reassignTo } }
    );
    // hats[] mirrors the primary reporting line; keep the two in step.
    await Admin.updateMany(
      { "hats.reportingManagerId": adminId },
      { $set: { "hats.$[h].reportingManagerId": reassignTo } },
      { arrayFilters: [{ "h.reportingManagerId": adminId }] }
    );
  }

  const now = new Date();
  await Admin.updateOne(
    { _id: adminId, status: { $ne: "exited" } },
    {
      $set: {
        status: "exited",
        // Access ends with employment. A separate field because it is a separate
        // question — see the header.
        isDisabled: true,
        "meta.exitedAt": new Date(`${exitedAt}T00:00:00.000Z`),
        "meta.exitReason": String(reason || ""),
        "meta.exitRecordedBy": actorId || null,
        "meta.exitRecordedAt": now,
      },
    }
  );

  const after = await Admin.findById(adminId, { name: 1, status: 1, isDisabled: 1, meta: 1, joinedAt: 1 }).lean();
  return {
    admin: after,
    reassigned: reports.length,
    // Proof the exit is not retroactive: the day before is still employed.
    employedOnLastDay: employedOn(after, exitedAt).employed,
    employedDayAfter: employedOn(after, new Date(new Date(`${exitedAt}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)).employed,
  };
};

// Mark a login as a service account rather than a person. Nothing infers this
// from a name; a human says so.
const markServiceAccount = async (adminId, actorId) => {
  if (!isId(adminId)) throw err(400, "Invalid admin id");
  const admin = await Admin.findById(adminId, { name: 1 }).lean();
  if (!admin) throw err(404, "Admin not found");
  await Admin.updateOne(
    { _id: adminId },
    { $set: { "meta.isServiceAccount": true, "meta.exitRecordedBy": actorId || null } }
  );
  return Admin.findById(adminId, { name: 1, meta: 1 }).lean();
};

const listExited = async () =>
  Admin.find({ status: "exited" }, { name: 1, email: 1, joinedAt: 1, meta: 1 })
    .sort({ "meta.exitedAt": -1 })
    .lean();

module.exports = { directReportsOf, exitImpact, recordExit, markServiceAccount, listExited };

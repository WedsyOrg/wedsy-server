const EnquiryService = require("../services/EnquiryService");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const { permissionSatisfies } = require("../middlewares/requirePermission");

// Walk UP the assigned admin's reportingManagerId chain and check whether `actorId`
// appears anywhere in it (i.e. is the assigned person's manager, transitively).
// Depth-capped and cycle-safe.
const isManagerOfAssigned = async (actorId, assignedToId) => {
  if (!actorId || !assignedToId) return false;
  let currentId = assignedToId;
  const seen = new Set();
  for (let depth = 0; depth < 10 && currentId; depth++) {
    const key = String(currentId);
    if (seen.has(key)) break;
    seen.add(key);
    const admin = await AdminRepository.findById(currentId);
    if (!admin || !admin.reportingManagerId) break;
    if (String(admin.reportingManagerId) === String(actorId)) return true;
    currentId = admin.reportingManagerId;
  }
  return false;
};

// Does this admin's role grant a leads:approve permission at any scope?
// (own is the lowest rank, so any leads:approve:* — or a broader wildcard — satisfies it.)
const actorHasApprovePermission = async (actorId) => {
  if (!actorId) return false;
  const admin = await AdminRepository.findById(actorId);
  if (!admin || !admin.roleId) return false;
  const role = await RoleRepository.findById(admin.roleId);
  if (!role || !Array.isArray(role.permissions)) return false;
  return permissionSatisfies(role.permissions, "leads:approve:own").allowed;
};

// POST /enquiry/:_id/disqualify
const RequestDisqualify = async (req, res) => {
  try {
    const updated = await EnquiryService.requestDisqualification(
      req.params._id,
      { reason: req.body.reason, note: req.body.note },
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Server error" : error.message;
    res.status(status).json({ message });
  }
};

// PUT /enquiry/:_id/disqualify-decision
// Eligibility is computed here (no requirePermission gate on the route) so the assigned
// person's MANAGER can approve even without a broad leads:approve permission.
const DecideDisqualify = async (req, res) => {
  try {
    const actorId = req.auth.user_id;
    const enquiry = await EnquiryRepository.findById(req.params._id);
    if (!enquiry) {
      return res.status(404).json({ message: "Enquiry not found" });
    }

    const canApprove_permission = await actorHasApprovePermission(actorId);
    const canApprove_manager = await isManagerOfAssigned(
      actorId,
      enquiry.assignedTo
    );
    const canApprove = canApprove_permission || canApprove_manager;

    const updated = await EnquiryService.decideDisqualification(
      req.params._id,
      { decision: req.body.decision, note: req.body.note },
      actorId,
      canApprove
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Server error" : error.message;
    res.status(status).json({ message });
  }
};

module.exports = {
  RequestDisqualify,
  DecideDisqualify,
  isManagerOfAssigned,
  actorHasApprovePermission,
};

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
  const { permissionsForAdmin } = require("../middlewares/requirePermission");
  const perms = await permissionsForAdmin(admin); // RBAC v2 union
  return permissionSatisfies(perms, "leads:approve:own").allowed;
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

// GET /enquiry/pending-disqualifications
// The Approvals page: every pending disqualification request awaiting THIS caller's
// decision. Eligibility is computed here (no requirePermission gate on the route) —
// EXACTLY mirroring DecideDisqualify, so who can SEE a request == who can DECIDE it:
//   canApprove = actorHasApprovePermission(actor)   → a Revenue Head / Founder sees ALL
//              OR isManagerOfAssigned(actor, owner)  → a manager sees their team's
// This matches who actually gets NOTIFIED (owner's reporting manager + Revenue Heads
// in notifyManagerOfDisqualification). Crucially it does NOT assume a manager exists:
// 9/13 admins historically had reportingManagerId null, so a manager-only query would
// silently hide their requests — the approve-permission branch (Revenue Head/Founder)
// is the safety net that guarantees those still surface. A caller with neither path
// gets an empty list (200, not 403), consistent with the un-gated decision route.
const PendingDisqualifications = async (req, res) => {
  try {
    const actorId = req.auth.user_id;
    const canApproveAll = await actorHasApprovePermission(actorId);
    const pending = await EnquiryRepository.findPendingDisqualifications();

    const items = [];
    for (const lead of pending) {
      const ownerId = lead.assignedTo?._id || lead.assignedTo;
      const eligible =
        canApproveAll || (await isManagerOfAssigned(actorId, ownerId));
      if (!eligible) continue;
      items.push({
        lead: {
          _id: lead._id,
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          stage: lead.stage,
          assignedTo: lead.assignedTo || null,
        },
        requester: lead.lostRequestedBy || null,
        reason: lead.lostReason || "",
        note: lead.lostNote || "",
        requestedAt: lead.lostRequestedAt || null,
      });
    }

    res.status(200).json({ items, total: items.length });
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
  PendingDisqualifications,
  isManagerOfAssigned,
  actorHasApprovePermission,
};

const EnquiryService = require("../services/EnquiryService");
const EnquiryRepository = require("../repositories/EnquiryRepository");
// Eligibility helpers live in the shared module so the controller and EnquiryService
// both import them from there — no controller <-> service circular require.
const {
  isManagerOfAssigned,
  actorHasApprovePermission,
} = require("../services/ApprovalEligibility");

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

// GET /enquiry/pending-disqualifications
// Lists pending-disqualification leads the current admin is allowed to approve.
// No requirePermission gate — eligibility is computed inside the service. Items are
// already trimmed to the API shape by the service.
const ListPendingDisqualifications = async (req, res) => {
  try {
    const result = await EnquiryService.listPendingForApprover(req.auth.user_id);
    res.status(200).json({ items: result, total: result.length });
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Server error" : error.message;
    res.status(status).json({ message });
  }
};

module.exports = {
  RequestDisqualify,
  DecideDisqualify,
  ListPendingDisqualifications,
  // Re-exported from the shared eligibility module so existing importers keep working.
  isManagerOfAssigned,
  actorHasApprovePermission,
};

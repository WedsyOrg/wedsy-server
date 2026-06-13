const express = require("express");
const router = express.Router();

const enquiry = require("../controllers/enquiry");
const enquiryPipeline = require("../controllers/enquiry-pipeline");
const disqualify = require("../controllers/disqualify");
const cockpit = require("../controllers/enquiry-cockpit");
const lifecycle = require("../controllers/enquiry-lifecycle");
const enquiryImport = require("../controllers/enquiry-import");
const fileUpload = require("express-fileupload");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

router.post("/", enquiry.CreateNew);
router.get("/", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), enquiry.GetAll);
router.put("/", CheckAdminLogin, enquiry.Update);
router.delete("/", CheckAdminLogin, enquiry.Delete);
// Lifecycle (Slice A): role-aware dashboard. Literal path — MUST stay above /:_id.
router.get(
  "/dashboard",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  lifecycle.Dashboard
);
// MB5 Slice 4: triage queue (literal paths above /:_id). leads:triage is the
// new permission — seed-granted to sales-lead-class roles; founder wildcard covers.
const triage = require("../controllers/triage");
// MB6 Slice 10: intern/presales rollup (derived only, scope-aware).
router.get(
  "/intern-metrics",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  async (req, res) => {
    try {
      const InternMetricsService = require("../services/InternMetricsService");
      res
        .status(200)
        .json(await InternMetricsService.internMetrics({ period: req.query.period }, req.scopeFilter || {}));
    } catch (error) {
      res.status(error.status || 500).json({ message: error.message });
    }
  }
);
router.get("/triage", CheckAdminLogin, requirePermission("leads:triage:own"), triage.List);
router.get("/triage/interns", CheckAdminLogin, requirePermission("leads:triage:own"), triage.Interns);
router.post(
  "/:_id/triage-assign",
  CheckAdminLogin,
  requirePermission("leads:triage:own"),
  triage.Assign
);
// Lifecycle (Slice F): founder CSV import (the Zoho migration tool). Literal
// paths above /:_id; multipart handled per-route via express-fileupload.
router.get(
  "/import/sample",
  CheckAdminLogin,
  requirePermission("leads:create:department"),
  enquiryImport.Sample
);
router.post(
  "/import/preview",
  CheckAdminLogin,
  requirePermission("leads:create:department"),
  fileUpload(),
  enquiryImport.Preview
);
router.post(
  "/import/commit",
  CheckAdminLogin,
  requirePermission("leads:create:department"),
  fileUpload(),
  enquiryImport.Commit
);
// Settings Suite (Slice 7b): bulk transfer — team-or-broader scope, verified per
// document inside the service. Literal path above /:_id.
router.post(
  "/bulk-transfer",
  CheckAdminLogin,
  requirePermission("leads:edit:team", { ownerField: "assignedTo" }),
  lifecycle.BulkTransfer
);
router.get("/:_id", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), enquiry.Get);
router.post("/:_id/user", CheckAdminLogin, enquiry.CreateUser);
router.post("/:_id/conversations", CheckAdminLogin, enquiry.AddConversation);
router.put(
  "/:_id/conversations/:conversationId",
  CheckAdminLogin,
  enquiry.UpdateConversation
);
router.delete(
  "/:_id/conversations/:conversationId",
  CheckAdminLogin,
  enquiry.DeleteConversation
);
router.put("/:_id/", CheckAdminLogin, enquiry.UpdateLead);
router.put("/:_id/notes", CheckAdminLogin, enquiry.UpdateNotes);
router.put("/:_id/call", CheckAdminLogin, enquiry.UpdateCallSchedule);
router.put(
  "/:_id/first-call",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  enquiry.SetFirstCall
);
// First-call cockpit (Phase 1A). Same gate as the disqualify request below:
// edit rights on leads (Sales Executive has leads:edit:own).
router.post(
  "/:_id/call-log",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.LogCall
);
router.post(
  "/:_id/follow-up",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.AddFollowUp
);
router.put(
  "/:_id/qualification",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.UpdateQualification
);
// MB6 Slice 6: the lead refuses a meeting — tag, escalate, notify.
router.post(
  "/:_id/meet-refused",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.MeetRefused
);
router.post(
  "/:_id/call-complete",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.CompleteCall
);
router.get(
  "/:_id/internal-events",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.GetInternalEvents
);
// Settings Suite: journey + custom field values.
router.get(
  "/:_id/journey",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.Journey
);
router.put(
  "/:_id/custom-fields",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.SetCustomFields
);
router.post(
  "/:_id/note",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.AddNote
);
router.put(
  "/:_id/tags",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.SetTags
);
// Lifecycle: follow-up completion (zero-orphan gate), recycle, convert.
router.put(
  "/:_id/follow-up/:followUpId/complete",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.CompleteFollowUp
);
router.post(
  "/:_id/recycle",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.Recycle
);
router.post(
  "/:_id/convert",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  lifecycle.Convert
);
router.put("/:_id/stage", CheckAdminLogin, enquiryPipeline.UpdateStage);
router.put("/:_id/assign", CheckAdminLogin, enquiryPipeline.UpdateAssignedTo);
// Requesting a disqualification needs edit rights on the lead (Sales Executive has leads:edit:own).
router.post(
  "/:_id/disqualify",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  disqualify.RequestDisqualify
);
// No requirePermission here — eligibility (manager OR leads:approve) is computed in the controller.
router.put(
  "/:_id/disqualify-decision",
  CheckAdminLogin,
  disqualify.DecideDisqualify
);

module.exports = router;

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
// ── MB8a Slice 3 — leads I'm on the team for (additive "my leads" surface).
// Literal path: MUST stay above /:_id. Roster-scoped inside the controller; no
// ownerField narrowing (the roster IS the soft grant), no 403 gating added.
const leadTeam = require("../controllers/leadTeam");
router.get(
  "/team/mine",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadTeam.MyLeads
);
// ── MB8c-1 — cross-lead journey dashboards. Literal paths: MUST stay above
// /:_id. The gate sets req.scope from the caller's existing leads:view grant;
// the service reuses that scope for breadth (own/team/dept/all). No new gating.
const journeyDashboard = require("../controllers/journeyDashboard");
router.get(
  "/steps/my-work",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  journeyDashboard.MyWork
);
router.get(
  "/pipeline-overview",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  journeyDashboard.PipelineOverview
);
// MB8c-2a-ii — "my follow-ups due" (literal path, above /:_id).
const followup = require("../controllers/followup");
router.get(
  "/followups/mine",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  followup.Mine
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
// Design-pass Slice 5: Kiara AI summary (lead-scoped; POST regenerates).
const kiaraSummary = require("../controllers/kiaraSummary");
router.get(
  "/:_id/kiara-summary",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  kiaraSummary.Get
);
router.post(
  "/:_id/kiara-summary",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  kiaraSummary.Regenerate
);

// ── MB7b Slice 1 — internal multi-member chat per lead (lead-scoped) ──────────
const leadChat = require("../controllers/leadChat");
router.get(
  "/:_id/chat",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadChat.List
);
router.get(
  "/:_id/chat/members",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadChat.Members
);
router.post(
  "/:_id/chat",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadChat.Post
);
// Edit/Delete are author-only (enforced in the service via authorId match).
router.patch(
  "/:_id/chat/:messageId",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  leadChat.Edit
);
router.delete(
  "/:_id/chat/:messageId",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  leadChat.Remove
);

// ── MB8a Slices 1–2 — lead TEAM ROSTER (Client Journey Engine foundation) ─────
// Read routes: leads:view scope. Modify routes: leads:edit scope. BOTH gate via
// ownerField assignedTo, so the lead's OWNER (the sales lead, own-scope) manages
// their own lead's team, while a broader-scope role (Revenue Head, team scope)
// manages teams across the leads in their scope. No new permission, no RBAC
// vocabulary change, no roster-based 403 gating — visibility stays soft (v1).
router.get(
  "/:_id/team",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadTeam.Get
);
router.get(
  "/:_id/team/options",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadTeam.Options
);
router.post(
  "/:_id/team",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadTeam.Add
);
router.delete(
  "/:_id/team/:memberId",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadTeam.Remove
);

// ── MB8b Slices 2–4 — per-lead JOURNEY STEPS (status, owners, deps, notes) ────
// Reads gate leads:view scope; mutations gate leads:edit scope. Both via
// ownerField assignedTo (same model as the roster) — owner manages own lead's
// steps, broader-scope roles manage across their scope.
const leadStep = require("../controllers/leadStep");
router.get(
  "/:_id/steps",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadStep.List
);
router.post(
  "/:_id/steps/instantiate",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadStep.Instantiate
);
router.patch(
  "/:_id/steps/:stepId",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadStep.Patch
);
router.post(
  "/:_id/steps/:stepId/notes",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadStep.AddNote
);
// ── MB8c-2a-i — per-step tasks (reuses leads:view/edit scope + ownerField). ───
router.get(
  "/:_id/steps/:stepId/tasks",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadStep.ListTasks
);
router.post(
  "/:_id/steps/:stepId/tasks",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadStep.CreateTask
);
router.patch(
  "/:_id/steps/:stepId/tasks/:taskId",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadStep.PatchTask
);

// ── MB8c-2a-ii — client FOLLOW-UPS + the accountability banner/nudge ──────────
router.get(
  "/:_id/followups",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  followup.ListForLead
);
router.post(
  "/:_id/followups",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  followup.Create
);
router.patch(
  "/:_id/followups/:followupId",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  followup.Patch
);
const accountability = require("../controllers/accountability");
router.get(
  "/:_id/accountability",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  accountability.Assess
);
router.post(
  "/:_id/accountability/nudge",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  accountability.Nudge
);

// ── MB7b Slice 4 — WhatsApp-group one-tap toggle (red-flag → Yes) ─────────────
const nurture = require("../controllers/nurture");
router.post(
  "/:_id/whatsapp-group",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  nurture.SetGroup
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
// MB9a — the explicit Qualify hinge (assignee OR their manager; scope-checked).
router.post(
  "/:_id/qualify",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  lifecycle.Qualify
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

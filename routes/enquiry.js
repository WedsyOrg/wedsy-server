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
// MB10 Slice 4 — per-document scope check on lead WRITE routes (runs after the
// requirePermission gate that sets req.scopeFilter via ownerField "assignedTo").
const { enforceLeadScope } = require("../middlewares/enforceLeadScope");
const LEADS_EDIT_SCOPED = [
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  enforceLeadScope("_id"),
];

router.post("/", enquiry.CreateNew);
router.get("/", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), enquiry.GetAll);
// Lifecycle bucket counts (additive). Literal path — MUST stay above /:_id.
// Same RBAC scope/permission as the list GET.
router.get(
  "/lifecycle-counts",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  enquiry.LifecycleCounts
);
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
// ── MB9c — list bulk actions (literal paths above /:_id). Scope-verified in the
// service. tag/stage/lost gate leads:edit; DELETE (soft) gates leads:delete:all
// (founder by default — existing RBAC vocab, no new permission).
const leadBulk = require("../controllers/leadBulk");
router.post(
  "/bulk-tag",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadBulk.Tag
);
router.post(
  "/bulk-stage",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadBulk.Stage
);
router.post(
  "/bulk-lost",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadBulk.Lost
);
router.post(
  "/bulk-archive",
  CheckAdminLogin,
  requirePermission("leads:delete:all", { ownerField: "assignedTo" }),
  leadBulk.Archive
);
// ── MB8a Slice 3 — leads I'm on the team for (additive "my leads" surface).
// Literal path: MUST stay above /:_id. Roster-scoped inside the controller; no
// ownerField narrowing (the roster IS the soft grant), no 403 gating added.
const leadTeam = require("../controllers/leadTeam");
const leadLane = require("../controllers/leadLane");
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
// ── MB9a-2 — golden-window SLA + rescue (literal paths, above /:_id). The gate
// sets req.scope from the caller's existing leads:view grant; reused for breadth.
const goldenWindow = require("../controllers/goldenWindow");
const rescue = require("../controllers/rescue");
router.get(
  "/respond-now",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  goldenWindow.RespondNow
);
router.get(
  "/golden-window/metrics",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  goldenWindow.Metrics
);
router.get(
  "/rescue-queue",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  rescue.Queue
);
// MB9b — role dashboards' funnel + golden-window aggregate (literal, above /:_id).
const funnelMetrics = require("../controllers/funnelMetrics");
router.get(
  "/funnel-metrics",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  funnelMetrics.Funnel
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
// MB10 Slice 4 — write-route scope sweep: these mutate a single lead by :_id and
// were previously CheckAdminLogin-only (any logged-in admin could write any lead).
// Now scope-gated consistent with reads.
router.put("/:_id/", CheckAdminLogin, ...LEADS_EDIT_SCOPED, enquiry.UpdateLead);
router.put("/:_id/notes", CheckAdminLogin, ...LEADS_EDIT_SCOPED, enquiry.UpdateNotes);
router.put("/:_id/call", CheckAdminLogin, ...LEADS_EDIT_SCOPED, enquiry.UpdateCallSchedule);
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
// WhatsApp deep-link press logged as employee activity (same edit gate as call-log).
router.post(
  "/:_id/whatsapp-activity",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  cockpit.WhatsappActivity
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
  ...LEADS_EDIT_SCOPED,
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
// #8 — reverse a qualification. No requirePermission gate here: eligibility
// (leads:approve OR the assignee's manager) is computed in the controller, EXACTLY
// like disqualify-decision, so interns are blocked while their manager isn't.
router.post(
  "/:_id/unqualify",
  CheckAdminLogin,
  lifecycle.Unqualify
);
// Slice B2 — set-once "proposal sent" marker (deal spine). Owner/manager
// WRITE gate (per-doc scope enforced); no roster fallback on writes.
router.post(
  "/:_id/proposal-sent",
  CheckAdminLogin,
  ...LEADS_EDIT_SCOPED,
  lifecycle.ProposalSent
);

// ── Slice B3 — WORKSTREAM LANES. Reads: view scope + roster fallback (the
// guard is in the controller). Writes: owner/manager scope OR the lane's own
// owner (checked per-request in the controller — enforceLeadScope would lock
// out lane owners, so it is deliberately NOT used here).
router.get(
  "/:_id/lanes",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadLane.List
);
router.post(
  "/:_id/lanes/assemble",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadLane.Assemble
);
router.post(
  "/:_id/lanes",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadLane.Add
);
router.patch(
  "/:_id/lanes/:laneId",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadLane.Patch
);
router.post(
  "/:_id/lanes/:laneId/entries",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadLane.AddEntry
);
// ── MB9a-2 — per-lead golden-window clock + rescue actions. Claim/reassign/
// dismiss gate leads:edit + ownerField, so only a manager/RevHead whose scope
// covers the breached lead can rescue it (an own-scope IC is out of scope).
router.get(
  "/:_id/golden-window",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  goldenWindow.LeadClock
);
router.post(
  "/:_id/rescue/claim",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  rescue.Claim
);
router.post(
  "/:_id/rescue/reassign",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  rescue.Reassign
);
router.post(
  "/:_id/rescue/dismiss",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  rescue.Dismiss
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
// Recover a lost lead back into the pipeline — same scope gate as the stage move
// it mirrors (LEADS_EDIT_SCOPED: leads:edit:own + ownerField + enforceLeadScope).
router.post("/:_id/recover", CheckAdminLogin, ...LEADS_EDIT_SCOPED, lifecycle.Recover);
// MB10 Slice 4 — stage + assign were CheckAdminLogin-only; now scope-gated.
router.put("/:_id/stage", CheckAdminLogin, ...LEADS_EDIT_SCOPED, enquiryPipeline.UpdateStage);
router.put("/:_id/assign", CheckAdminLogin, ...LEADS_EDIT_SCOPED, enquiryPipeline.UpdateAssignedTo);
// Requesting a disqualification needs edit rights on the lead (Sales Executive has
// leads:edit:own). MB10 Slice 4: now also scope-checked per-document (ownerField +
// enforceLeadScope) so an out-of-scope caller cannot mark a lead disqualified.
router.post(
  "/:_id/disqualify",
  CheckAdminLogin,
  ...LEADS_EDIT_SCOPED,
  disqualify.RequestDisqualify
);
// No requirePermission here — eligibility (manager OR leads:approve) is computed in the controller.
router.put(
  "/:_id/disqualify-decision",
  CheckAdminLogin,
  disqualify.DecideDisqualify
);

module.exports = router;

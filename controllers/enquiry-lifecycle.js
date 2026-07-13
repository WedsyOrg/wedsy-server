const DashboardService = require("../services/DashboardService");
const JourneyService = require("../services/JourneyService");
const CustomFieldService = require("../services/CustomFieldService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const ProjectService = require("../services/ProjectService");
const EnquiryService = require("../services/EnquiryService");
// #8 — eligibility helpers shared with the disqualify-decision flow: a leads:approve
// holder (Sales Lead / Revenue Head) OR the assignee's manager chain may approve.
const { actorHasApprovePermission, isManagerOfAssigned } = require("./disqualify");
const EnquiryRepository = require("../repositories/EnquiryRepository");

const respondError = (res, error) => {
  const status = error.status || 500;
  const message = status === 500 ? "Server error" : error.message;
  if (status === 500) console.error("[lifecycle]", error);
  res.status(status).json({ message });
};

// GET /enquiry/dashboard — the role-aware morning briefing. Every query inside is
// bounded to the caller's effective scope (req.scope/req.scopeFilter from
// requirePermission("leads:view:own", { ownerField: "assignedTo" })).
const Dashboard = async (req, res) => {
  try {
    const payload = await DashboardService.buildDashboard(
      req.auth.user_id,
      req.scope,
      req.scopeFilter || {}
    );
    res.status(200).json(payload);
  } catch (error) {
    respondError(res, error);
  }
};

// PUT /enquiry/:_id/follow-up/:followUpId/complete — the zero-orphan gate lives
// in LeadLifecycleService (422 when an open lead would exit into nothing).
const CompleteFollowUp = async (req, res) => {
  try {
    const result = await LeadLifecycleService.completeFollowUp(
      req.params._id,
      req.params.followUpId,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/qualify — the explicit qualify hinge (assignee OR manager).
// Scope-checked against the caller's leads:edit scope; converges on the SAME
// LeadLifecycleService.qualifyLead transition as the cockpit qualified path.
const Qualify = async (req, res) => {
  try {
    const Enquiry = require("../models/Enquiry");
    const mongoose = require("mongoose");
    const id = req.params._id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid lead id" });
    const inScope = await Enquiry.findOne({ $and: [{ _id: id }, req.scopeFilter || {}] }, { _id: 1 }).lean();
    if (!inScope) return res.status(403).json({ message: "Out of your scope" });
    const result = await LeadLifecycleService.qualifyLead(id, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/proposal-sent — { amount? }. Slice B2: set-once proposal
// marker (409 if already set). Route gates LEADS_EDIT_SCOPED (owner/manager
// scope + per-doc enforceLeadScope) — deliberately NO roster fallback: reads
// widened in B1, writes stay owner-gated.
const ProposalSent = async (req, res) => {
  try {
    const result = await LeadLifecycleService.markProposalSent(
      req.params._id,
      { amount: req.body?.amount },
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// PATCH /enquiry/:_id/deal-total — { amount } (owner/manager write gate).
const DealTotal = async (req, res) => {
  try {
    res.status(200).json(await LeadLifecycleService.setDealTotal(req.params._id, req.body?.amount, req.auth.user_id));
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/onboard — { feeAmount, dealTotal?, mode?, note? }. The win
// hinge (Slice B5a) — onboard from ANY live stage; dup → 409.
const Onboard = async (req, res) => {
  try {
    res.status(200).json(await LeadLifecycleService.onboardClient(req.params._id, req.body || {}, req.auth.user_id));
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/unqualify — reverse a qualification. No requirePermission on
// the route: eligibility is computed here EXACTLY like disqualify-decision, so only
// a leads:approve holder (Sales Lead / Revenue Head) OR the assignee's manager may
// do it — interns are blocked (403). Body: { reason } (required).
const Unqualify = async (req, res) => {
  try {
    const actorId = req.auth.user_id;
    const enquiry = await EnquiryRepository.findById(req.params._id);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const canApprove =
      (await actorHasApprovePermission(actorId)) ||
      (await isManagerOfAssigned(actorId, enquiry.assignedTo));
    if (!canApprove) {
      return res.status(403).json({ message: "Only a sales lead or revenue head can unqualify a lead" });
    }

    const result = await LeadLifecycleService.unqualifyLead(
      req.params._id,
      actorId,
      { reason: req.body.reason }
    );
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/recycle
const Recycle = async (req, res) => {
  try {
    const updated = await LeadLifecycleService.recycleLead(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/recover — un-lost an approved-lost lead back into the pipeline.
const Recover = async (req, res) => {
  try {
    const updated = await EnquiryService.recoverLead(
      req.params._id,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/convert — Meeting Scheduled → Project (terminal "won").
const Convert = async (req, res) => {
  try {
    const project = await ProjectService.convertLead(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(201).json(project);
  } catch (error) {
    respondError(res, error);
  }
};

// GET /enquiry/:_id/journey — the lead's full chronological story (Slice 5).
const Journey = async (req, res) => {
  try {
    res.status(200).json(await JourneyService.buildJourney(req.params._id));
  } catch (error) {
    respondError(res, error);
  }
};

// PUT /enquiry/:_id/custom-fields (Slice 3) — validated against active defs.
const SetCustomFields = async (req, res) => {
  try {
    const updated = await CustomFieldService.setLeadValues(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/note (Redesign) — quick note: commented event + legacy blob.
const AddNote = async (req, res) => {
  try {
    const updated = await LeadLifecycleService.addNote(
      req.params._id,
      (req.body || {}).text,
      req.auth.user_id
    );
    res.status(201).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// PUT /enquiry/:_id/tags (Slice 7a)
const SetTags = async (req, res) => {
  try {
    const updated = await LeadLifecycleService.setTags(
      req.params._id,
      (req.body || {}).tags,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/bulk-transfer (Slice 7b) — per-document scope check inside.
const BulkTransfer = async (req, res) => {
  try {
    const result = await LeadLifecycleService.bulkTransfer(
      req.body || {},
      req.auth.user_id,
      req.scopeFilter || {}
    );
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/unsnooze (Slice A2) — clears the park; the follow-up stays
// (it's just no longer parking the lead). Owner/manager scope at the route.
const Unsnooze = async (req, res) => {
  try {
    const SnoozeService = require("../services/SnoozeService");
    const result = await SnoozeService.unsnooze(req.params._id, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

module.exports = { Dashboard, CompleteFollowUp, Recycle, Recover, Convert, Journey, SetCustomFields, SetTags, BulkTransfer, AddNote, Qualify, Unqualify, ProposalSent, DealTotal, Onboard, Unsnooze };

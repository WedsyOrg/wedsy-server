const JourneyDashboardService = require("../services/JourneyDashboardService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[journeyDashboard]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong loading the journey board — please retry." : error.message });
};

// GET /enquiry/steps/my-work — the caller's steps across all their leads.
// requirePermission set req.scope (own/team/department/all) from the caller's
// existing leads:view grant — reused as-is for breadth (no new gating).
const MyWork = async (req, res) => {
  try {
    const result = await JourneyDashboardService.myWork(req.auth.user_id, req.scope || "own", {
      status: req.query.status,
      phase: req.query.phase,
      overdueOnly: req.query.overdueOnly === "true",
      includeComplete: req.query.includeComplete === "true",
    });
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/pipeline-overview — leads grouped by journey phase (or stage),
// scoped by the caller's existing leads:view scope (all vs roster). Soft.
const PipelineOverview = async (req, res) => {
  try {
    const result = await JourneyDashboardService.pipelineOverview(req.auth.user_id, req.scope || "own", {
      phase: req.query.phase,
      stuckOnly: req.query.stuckOnly === "true",
      memberId: req.query.memberId,
    });
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { MyWork, PipelineOverview };

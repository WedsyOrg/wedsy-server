const FunnelMetricsService = require("../services/FunnelMetricsService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[funnelMetrics]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong loading funnel metrics — please retry." : error.message });
};

// GET /enquiry/funnel-metrics?period=week|month — the role dashboards' funnel +
// golden-window aggregate, scoped by the caller's existing leads:view scope
// (own → intern view; team → sales-lead view; all → revenue-head view).
const Funnel = async (req, res) => {
  try {
    const period = req.query.period === "month" ? "month" : "week";
    res.status(200).json(await FunnelMetricsService.funnel(req.auth.user_id, req.scope || "own", { period }));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Funnel };

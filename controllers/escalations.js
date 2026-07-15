// W5 — GET /escalations?scope=team|all&page&limit
const EscalationReadService = require("../services/EscalationReadService");

const List = async (req, res) => {
  try {
    const out = await EscalationReadService.list({
      callerId: req.auth.user_id,
      reqScope: req.scope,
      reqScopeFilter: req.scopeFilter || {},
      requestedScope: req.query.scope,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load escalations — please retry." : error.message });
  }
};

module.exports = { List };

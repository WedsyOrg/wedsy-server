// Journey v2 (V8) — the lead's commitments read (roster-aware).
const CommitmentService = require("../services/CommitmentService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

// GET /enquiry/:_id/commitments
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json({ commitments: await CommitmentService.listCommitments(req.params._id) });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error("[commitments]", error);
    res.status(status).json({
      message: status === 500 ? "Something went wrong loading commitments — please retry." : error.message,
    });
  }
};

module.exports = { List };

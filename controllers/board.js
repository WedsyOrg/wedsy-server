// W3 — GET /enquiry/board — the station kanban read.
// C1 — ?scope=participant narrows to "leads I'm on" (self, or ?adminId= for a
// report inside the caller's permission scope) with the FULL column set;
// column values stay role-gated by the caller's real scope, as shipped.
const BoardService = require("../services/BoardService");

const Board = async (req, res) => {
  try {
    let scopeFilter = req.scopeFilter || {};
    const opts = {};
    if (req.query.scope === "participant") {
      const ParticipantScopeService = require("../services/ParticipantScopeService");
      const target = await ParticipantScopeService.resolveParticipantTarget(req);
      scopeFilter = await ParticipantScopeService.participantFilter(target);
      opts.fullColumns = true; // worked post-qual leads — every station column
    }
    const out = await BoardService.board(req.auth.user_id, req.scope || "own", scopeFilter, opts);
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load the board — please retry." : error.message });
  }
};

module.exports = { Board };

// W3 — GET /enquiry/board — the station kanban read.
const BoardService = require("../services/BoardService");

const Board = async (req, res) => {
  try {
    const out = await BoardService.board(req.auth.user_id, req.scope || "own", req.scopeFilter || {});
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load the board — please retry." : error.message });
  }
};

module.exports = { Board };

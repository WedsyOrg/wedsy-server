// W1 — /me/* — the caller's own workspace surface (department switcher).
const WorkspaceService = require("../services/WorkspaceService");

// GET /me/workspaces
const Workspaces = async (req, res) => {
  try {
    const out = await WorkspaceService.workspacesFor(req.auth.user_id);
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load your workspaces — please retry." : error.message });
  }
};

// PUT /me/workspace { id }
const SetWorkspace = async (req, res) => {
  try {
    const out = await WorkspaceService.setWorkspace(req.auth.user_id, req.body && req.body.id);
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not save your workspace — please retry." : error.message });
  }
};

module.exports = { Workspaces, SetWorkspace };

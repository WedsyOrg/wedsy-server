const OrgService = require("../services/OrgService");

// GET /org/chart — the reporting tree (read-only). Gated users:view:all.
const Chart = async (req, res) => {
  try {
    const result = await OrgService.chart();
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Something went wrong loading the org chart — please retry." });
  }
};

// GET /org/permission-matrix — roles × resource:action scopes (read-only).
// Gated roles:view:all. Edits route through the EXISTING PUT /role/:id.
const PermissionMatrix = async (req, res) => {
  try {
    const result = await OrgService.permissionMatrix(req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Something went wrong loading the org chart — please retry." });
  }
};

module.exports = { Chart, PermissionMatrix };

const ProjectService = require("../services/ProjectService");

// GET /project — scope-filtered by csOwnerId (own) vs department/all per the
// caller's projects:view permission.
const GetAll = async (req, res) => {
  try {
    const projects = await ProjectService.listProjects(req.scopeFilter || {});
    res.status(200).json(projects);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Server error" : error.message });
  }
};

module.exports = { GetAll };

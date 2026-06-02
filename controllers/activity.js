const ActivityLogService = require("../services/ActivityLogService");

// GET /activity?limit=&skip=&entityType=
const GetAll = async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const skip = req.query.skip ? parseInt(req.query.skip, 10) : undefined;
    const entityType = req.query.entityType || undefined;
    const result = await ActivityLogService.getRecent({ limit, skip, entityType });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

module.exports = { GetAll };

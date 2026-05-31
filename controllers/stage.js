const StageService = require("../services/StageService");

// GET /stages
const GetAll = async (req, res) => {
  try {
    const result = await StageService.getAllStages();
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// POST /stages
const Create = async (req, res) => {
  try {
    const { name, color, category } = req.body || {};
    const actorId = req.auth && req.auth.user_id;
    const stage = await StageService.createStage(
      { name, color, category },
      actorId
    );
    res.status(201).json(stage);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// PUT /stages/:id
const Update = async (req, res) => {
  try {
    const { name, color, category, order } = req.body || {};
    const actorId = req.auth && req.auth.user_id;
    const stage = await StageService.updateStage(
      req.params.id,
      { name, color, category, order },
      actorId
    );
    res.status(200).json(stage);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// PUT /stages/reorder  (note: route must be registered BEFORE /:id)
const Reorder = async (req, res) => {
  try {
    const { orderedIds } = req.body || {};
    const actorId = req.auth && req.auth.user_id;
    const result = await StageService.reorderStages(orderedIds, actorId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// DELETE /stages/:id?moveTo=<slug>  (also accepts body.moveTo as a fallback)
const Delete = async (req, res) => {
  try {
    const moveTo = (req.query && req.query.moveTo) || (req.body && req.body.moveTo);
    const actorId = req.auth && req.auth.user_id;
    const result = await StageService.deleteStage(req.params.id, moveTo, actorId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

module.exports = { GetAll, Create, Update, Reorder, Delete };

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
module.exports = { GetAll };

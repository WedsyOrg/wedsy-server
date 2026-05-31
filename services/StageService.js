const StageRepository = require("../repositories/StageRepository");
const getAllStages = async () => {
  const stages = await StageRepository.findAll();
  return { stages };
};
module.exports = { getAllStages };

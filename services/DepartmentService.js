const DepartmentRepository = require("../repositories/DepartmentRepository");

const getAll = async () => {
  return await DepartmentRepository.findAllActive();
};

module.exports = {
  getAll,
};

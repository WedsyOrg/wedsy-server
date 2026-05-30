const RoleRepository = require("../repositories/RoleRepository");

const getAll = async () => {
  return await RoleRepository.findAllActive();
};

module.exports = {
  getAll,
};

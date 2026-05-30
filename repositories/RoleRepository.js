const Role = require("../models/Role");

const findAllActive = async () => {
  return await Role.find({ deletedAt: null }).sort({ name: 1 }).lean();
};

module.exports = {
  findAllActive,
};

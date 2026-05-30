const Department = require("../models/Department");

const findAllActive = async () => {
  return await Department.find({ deletedAt: null }).sort({ name: 1 }).lean();
};

module.exports = {
  findAllActive,
};

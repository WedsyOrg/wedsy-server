const Role = require("../models/Role");

const findAllActive = async () => {
  return await Role.find({ deletedAt: null }).sort({ name: 1 }).lean();
};

const findById = async (_id) => {
  return await Role.findById(_id).lean();
};

module.exports = {
  findAllActive,
  findById,
};

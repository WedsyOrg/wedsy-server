const Role = require("../models/Role");

const findAllActive = async () => {
  return await Role.find({ deletedAt: null }).sort({ name: 1 }).lean();
};

const findById = async (_id) => {
  return await Role.findById(_id).lean();
};

const updateById = async (_id, fields) => {
  return await Role.findByIdAndUpdate(
    _id,
    { $set: fields },
    { new: true, runValidators: true, context: "query" }
  ).lean();
};

module.exports = {
  findAllActive,
  findById,
  updateById,
};

const StepDefinition = require("../models/StepDefinition");

// Active definitions, ordered. Reads power both the Settings editor and per-lead
// instantiation.
const findActive = async () => StepDefinition.find({ status: "active" }).sort({ order: 1 }).lean();

const findAll = async () => StepDefinition.find({}).sort({ order: 1 }).lean();

const findById = async (id) => StepDefinition.findById(id);

const findBySystemKey = async (systemKey) => StepDefinition.findOne({ systemKey }).lean();

const create = async (fields) => StepDefinition.create(fields);

const updateById = async (id, fields) =>
  StepDefinition.findByIdAndUpdate(id, { $set: fields }, { new: true, runValidators: true }).lean();

// Highest current order (so a new step appends to the end).
const maxOrder = async () => {
  const top = await StepDefinition.findOne({}, { order: 1 }).sort({ order: -1 }).lean();
  return top ? top.order || 0 : 0;
};

module.exports = { findActive, findAll, findById, findBySystemKey, create, updateById, maxOrder };

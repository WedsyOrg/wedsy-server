const Stage = require("../models/Stage");
const Enquiry = require("../models/Enquiry");

const findAll = async () =>
  Stage.find({ deletedAt: null }).sort({ order: 1 }).lean();

const findBySlug = async (slug) =>
  Stage.findOne({ slug, deletedAt: null }).lean();

const findById = async (id) =>
  Stage.findOne({ _id: id, deletedAt: null }).lean();

const countAll = async () => Stage.countDocuments({ deletedAt: null });

const create = async (doc) => {
  const created = await Stage.create(doc);
  return created.toObject();
};

const updateById = async (id, fields) =>
  Stage.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();

const softDeleteById = async (id) =>
  Stage.findByIdAndUpdate(
    id,
    { $set: { deletedAt: new Date() } },
    { new: true }
  ).lean();

const maxOrder = async () => {
  const top = await Stage.find({ deletedAt: null })
    .sort({ order: -1 })
    .limit(1)
    .lean();
  return top.length ? top[0].order : -1;
};

// Lead-side helpers — read/update the Enquiry.stage value only (no schema change).
const countLeadsInStage = async (slug) =>
  Enquiry.countDocuments({ stage: slug });

const reassignLeads = async (fromSlug, toSlug) => {
  const res = await Enquiry.updateMany(
    { stage: fromSlug },
    { $set: { stage: toSlug } }
  );
  return res.modifiedCount;
};

module.exports = {
  findAll,
  findBySlug,
  findById,
  countAll,
  create,
  updateById,
  softDeleteById,
  maxOrder,
  countLeadsInStage,
  reassignLeads,
};

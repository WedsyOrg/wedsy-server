const WeddingMilestone = require('../models/WeddingMilestone');

const create = async (eventId, data) => {
  return await new WeddingMilestone({ ...data, eventId }).save();
};

const findByEventId = async (eventId) => {
  return await WeddingMilestone
    .find({ eventId })
    .sort({ dueDate: 1 })
    .lean();
};

const findById = async (milestoneId) => {
  return await WeddingMilestone.findById(milestoneId);
};

const updateById = async (milestoneId, updates) => {
  return await WeddingMilestone.findByIdAndUpdate(milestoneId, updates, { new: true });
};

const deleteById = async (milestoneId) => {
  return await WeddingMilestone.findByIdAndDelete(milestoneId);
};

const markCompleted = async (milestoneId) => {
  return await WeddingMilestone.findByIdAndUpdate(
    milestoneId,
    { status: 'COMPLETED', completedAt: new Date() },
    { new: true }
  );
};

const markPending = async (milestoneId) => {
  return await WeddingMilestone.findByIdAndUpdate(
    milestoneId,
    { status: 'PENDING', completedAt: null },
    { new: true }
  );
};

module.exports = {
  create,
  findByEventId,
  findById,
  updateById,
  deleteById,
  markCompleted,
  markPending,
};

const WeddingMilestoneRepository = require('../repositories/WeddingMilestoneRepository');
// TODO: replace direct Event model use with EventRepository once that exists.
const Event = require('../models/Event');

const ALLOWED_UPDATE_FIELDS = ['title', 'dueDate', 'status', 'linkedDayIndex'];
const ALLOWED_STATUS_VALUES = ['PENDING', 'COMPLETED'];

async function assertEventOwnership(eventId, userId, isAdmin) {
  const event = await Event.findById(eventId).lean();
  if (!event) {
    throw new Error('Event not found');
  }
  if (!isAdmin && event.user.toString() !== userId.toString()) {
    throw new Error('Unauthorized');
  }
  return event;
}

const getTimeline = async (eventId, userId, isAdmin) => {
  await assertEventOwnership(eventId, userId, isAdmin);
  // TODO: merge AUTO milestones derived from eventDays in a later sub-phase.
  return await WeddingMilestoneRepository.findByEventId(eventId);
};

const createCustom = async (eventId, userId, isAdmin, data) => {
  if (!data || typeof data.title !== 'string' || !data.title.trim() || !data.dueDate) {
    throw new Error('Title and dueDate required');
  }
  await assertEventOwnership(eventId, userId, isAdmin);
  return await WeddingMilestoneRepository.create(eventId, {
    title: data.title,
    dueDate: data.dueDate,
    linkedDayIndex: data.linkedDayIndex || null,
    source: 'Custom',
  });
};

const createAI = async (eventId, userId, isAdmin, data) => {
  if (!data || typeof data.title !== 'string' || !data.title.trim() || !data.dueDate) {
    throw new Error('Title and dueDate required');
  }
  await assertEventOwnership(eventId, userId, isAdmin);
  return await WeddingMilestoneRepository.create(eventId, {
    title: data.title,
    dueDate: data.dueDate,
    linkedDayIndex: data.linkedDayIndex || null,
    source: 'AI',
  });
};

const updateMilestone = async (milestoneId, userId, isAdmin, updates) => {
  const milestone = await WeddingMilestoneRepository.findById(milestoneId);
  if (!milestone) {
    throw new Error('Milestone not found');
  }
  await assertEventOwnership(milestone.eventId, userId, isAdmin);

  const patch = {};
  for (const field of ALLOWED_UPDATE_FIELDS) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, field)) {
      patch[field] = updates[field];
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    if (!ALLOWED_STATUS_VALUES.includes(patch.status)) {
      throw new Error('Invalid status');
    }
    if (patch.status === 'COMPLETED') {
      patch.completedAt = new Date();
    } else if (patch.status === 'PENDING') {
      patch.completedAt = null;
    }
  }

  return await WeddingMilestoneRepository.updateById(milestoneId, patch);
};

const deleteMilestone = async (milestoneId, userId, isAdmin) => {
  const milestone = await WeddingMilestoneRepository.findById(milestoneId);
  if (!milestone) {
    throw new Error('Milestone not found');
  }
  await assertEventOwnership(milestone.eventId, userId, isAdmin);
  await WeddingMilestoneRepository.deleteById(milestoneId);
  return { success: true };
};

module.exports = {
  getTimeline,
  createCustom,
  createAI,
  updateMilestone,
  deleteMilestone,
};

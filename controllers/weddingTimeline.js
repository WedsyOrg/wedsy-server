const WeddingTimelineService = require('../services/WeddingTimelineService');
const AITimelineService = require('../services/AITimelineService');

function mapErrorToStatus(message) {
  if (message === 'Event not found' || message === 'Milestone not found') return 404;
  if (message === 'Unauthorized') return 403;
  if (message === 'Title and dueDate required' || message === 'Invalid status') return 400;
  return 500;
}

const GetTimeline = async (req, res) => {
  try {
    const timeline = await WeddingTimelineService.getTimeline(
      req.params.eventId,
      req.auth.user_id,
      req.auth.isAdmin
    );
    res.status(200).send({ message: 'success', timeline });
  } catch (error) {
    res.status(mapErrorToStatus(error.message)).send({ message: 'error', error: error.message });
  }
};

const CreateMilestone = async (req, res) => {
  try {
    const milestone = await WeddingTimelineService.createCustom(
      req.params.eventId,
      req.auth.user_id,
      req.auth.isAdmin,
      req.body
    );
    res.status(201).send({ message: 'success', milestone });
  } catch (error) {
    res.status(mapErrorToStatus(error.message)).send({ message: 'error', error: error.message });
  }
};

const UpdateMilestone = async (req, res) => {
  try {
    const milestone = await WeddingTimelineService.updateMilestone(
      req.params.milestoneId,
      req.auth.user_id,
      req.auth.isAdmin,
      req.body
    );
    res.status(200).send({ message: 'success', milestone });
  } catch (error) {
    res.status(mapErrorToStatus(error.message)).send({ message: 'error', error: error.message });
  }
};

const DeleteMilestone = async (req, res) => {
  try {
    await WeddingTimelineService.deleteMilestone(
      req.params.milestoneId,
      req.auth.user_id,
      req.auth.isAdmin
    );
    res.status(200).send({ message: 'success' });
  } catch (error) {
    res.status(mapErrorToStatus(error.message)).send({ message: 'error', error: error.message });
  }
};

const RegenerateTimeline = async (req, res) => {
  try {
    const suggestions = await AITimelineService.regenerate(
      req.params.eventId,
      req.auth.user_id,
      req.auth.isAdmin
    );
    res.status(200).send({ message: 'success', suggestions });
  } catch (error) {
    const status = error.message === 'AI service unavailable' ? 503 : mapErrorToStatus(error.message);
    res.status(status).send({ message: 'error', error: error.message });
  }
};

module.exports = { GetTimeline, CreateMilestone, RegenerateTimeline, UpdateMilestone, DeleteMilestone };

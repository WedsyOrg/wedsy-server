const { callWithTool } = require('../utils/anthropic');
const Event = require('../models/Event');
const WeddingMilestoneRepository = require('../repositories/WeddingMilestoneRepository');

// TODO: extract to a shared events/ownership.js helper in a later sub-phase.
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

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return null;
}

const PROPOSE_TIMELINE_TOOL = {
  name: 'propose_timeline_changes',
  description: 'Propose additions, adjustments, and removals to a wedding planning timeline.',
  input_schema: {
    type: 'object',
    properties: {
      add: {
        type: 'array',
        description: 'New milestones to add to the timeline.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, action-oriented milestone title (e.g., "Send save-the-dates"). Maximum 80 characters.' },
            dueDate: { type: 'string', description: 'ISO 8601 date (YYYY-MM-DD) when this should be done by.' },
            reason: { type: 'string', description: 'One short sentence explaining why this milestone matters.' },
          },
          required: ['title', 'dueDate', 'reason'],
        },
      },
      adjust: {
        type: 'array',
        description: 'Existing milestones whose due date or title should change.',
        items: {
          type: 'object',
          properties: {
            milestoneId: { type: 'string', description: 'The _id of the existing milestone (provided to you in the input).' },
            newDueDate: { type: 'string', description: 'New ISO 8601 date if the date should change. Omit if no date change.' },
            newTitle: { type: 'string', description: 'New title if the title should change. Omit if no title change.' },
            reason: { type: 'string', description: 'One short sentence explaining the adjustment.' },
          },
          required: ['milestoneId', 'reason'],
        },
      },
      remove: {
        type: 'array',
        description: 'Existing milestones that should be removed (no longer relevant or wrong).',
        items: {
          type: 'object',
          properties: {
            milestoneId: { type: 'string', description: 'The _id of the milestone to remove.' },
            reason: { type: 'string', description: 'One short sentence explaining why it should be removed.' },
          },
          required: ['milestoneId', 'reason'],
        },
      },
    },
    required: ['add', 'adjust', 'remove'],
  },
};

const SYSTEM_PROMPT = `You are a wedding-planning assistant for Wedsy, an Indian wedding-services platform. You help couples in Bengaluru build a sensible planning timeline.

You are given:
- The event's metadata (couple's wedding info, dates, community, venues)
- The list of existing planning milestones already on their timeline (with IDs, titles, due dates, status)

Your job: propose changes to the timeline by calling the propose_timeline_changes tool. You may:
- Add new milestones that are missing (e.g., common wedding-planning steps the user has not yet captured)
- Adjust existing milestones whose due dates seem wrong relative to the wedding date
- Remove existing milestones that are duplicates or clearly inappropriate

Constraints:
- Be conservative. Suggest 3-7 additions maximum, only when genuinely useful. Quality over quantity.
- All due dates must be BEFORE the wedding date (the latest event day's date), and AFTER today.
- Don't suggest adjusting a milestone unless the existing date is more than 14 days off from a sensible date.
- Don't suggest removing a milestone unless it is truly redundant.
- Titles should be 3-8 words, action-oriented, in title case (e.g., "Book photographer", "Send save-the-dates", "Confirm venue floor plan").
- Reasons should be one short sentence, no marketing fluff.
- Use Indian wedding context: mehendi, sangeet, haldi, baraat, reception, etc., are normal events.
- ALWAYS return all three arrays (add, adjust, remove) — empty arrays are fine if no changes needed in that category.`;

const regenerate = async (eventId, userId, isAdmin) => {
  const event = await assertEventOwnership(eventId, userId, isAdmin);
  const milestones = await WeddingMilestoneRepository.findByEventId(eventId);

  const today = toIsoDate(new Date());

  const eventDays = Array.isArray(event.eventDays) ? event.eventDays : [];
  let weddingDate = null;
  for (const day of eventDays) {
    const iso = toIsoDate(day.date);
    if (iso && (!weddingDate || iso > weddingDate)) {
      weddingDate = iso;
    }
  }

  const context = {
    today,
    weddingDate,
    coupleName: event.name,
    community: event.community,
    eventDays: eventDays.map((d) => ({
      name: d.name,
      date: toIsoDate(d.date),
      time: d.time,
      venue: d.venue,
    })),
    existingMilestones: (milestones || []).map((m) => ({
      _id: m._id.toString(),
      title: m.title,
      dueDate: toIsoDate(m.dueDate),
      status: m.status,
      source: m.source,
    })),
  };

  const userMessageText = `Here is the wedding context. Propose timeline changes by calling the propose_timeline_changes tool.\n\n${JSON.stringify(context, null, 2)}`;

  const result = await callWithTool({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessageText }],
    tool: PROPOSE_TIMELINE_TOOL,
    callerId: 'AITimelineService.regenerate',
  });

  if (result === null) {
    throw new Error('AI service unavailable');
  }

  return result;
};

module.exports = { regenerate };

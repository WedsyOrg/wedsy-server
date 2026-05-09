const mongoose = require('mongoose');
const ObjectId = mongoose.Schema.Types.ObjectId;

const WeddingMilestoneSchema = new mongoose.Schema(
  {
    eventId: { type: ObjectId, ref: 'Event', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    dueDate: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED'],
      default: 'PENDING',
    },
    source: { type: String, enum: ['AI', 'Custom'], required: true },
    linkedDayIndex: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WeddingMilestoneSchema.index({ eventId: 1, dueDate: 1 });

module.exports = mongoose.model('WeddingMilestone', WeddingMilestoneSchema);

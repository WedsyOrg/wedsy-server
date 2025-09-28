const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const TaskSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
    },
    completed: { type: Boolean, default: false },
    task: { type: String, required: true },
    deadline: { type: Date, required: true },
    referenceId: { type: ObjectId, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Task", TaskSchema);

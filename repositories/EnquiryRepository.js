const Enquiry = require("../models/Enquiry");

// Find an enquiry by _id. Returns the document or null.
const findById = async (_id) => {
  return await Enquiry.findById(_id);
};

// Update an enquiry's stage by _id. Returns the updated document or null.
const updateStageById = async (_id, stage) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { stage },
    { new: true, runValidators: true }
  );
};

// Update an enquiry's assignedTo by _id. assignedTo can be an Admin _id or null.
// Returns the updated document or null.
const updateAssignedToById = async (_id, assignedTo) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { assignedTo },
    { new: true, runValidators: true }
  );
};

module.exports = {
  findById,
  updateStageById,
  updateAssignedToById,
};

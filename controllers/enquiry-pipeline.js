const EnquiryService = require("../services/EnquiryService");

// PUT /enquiry/:_id/stage
const UpdateStage = async (req, res) => {
  try {
    const updated = await EnquiryService.updateStage(
      req.params._id,
      req.body.stage,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Server error" : error.message;
    res.status(status).json({ message });
  }
};

// PUT /enquiry/:_id/assign
const UpdateAssignedTo = async (req, res) => {
  try {
    const updated = await EnquiryService.updateAssignedTo(
      req.params._id,
      req.body.assignedTo,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Server error" : error.message;
    res.status(status).json({ message });
  }
};

module.exports = {
  UpdateStage,
  UpdateAssignedTo,
};

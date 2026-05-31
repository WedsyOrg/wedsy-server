const mongoose = require("mongoose");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const AdminRepository = require("../repositories/AdminRepository");
const StageRepository = require("../repositories/StageRepository");

// Update an enquiry's pipeline stage.
// Throws { status, message } shaped errors for the controller to map to HTTP responses.
const updateStage = async (enquiryId, stage, updatedBy) => {
  if (typeof stage !== "string" || stage.length === 0) {
    const err = new Error("Stage is required");
    err.status = 400;
    throw err;
  }
  const validStage = await StageRepository.findBySlug(stage);
  if (!validStage) {
    const err = new Error(`Invalid stage: ${stage}`);
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    const err = new Error("Invalid enquiry id");
    err.status = 400;
    throw err;
  }
  const updated = await EnquiryRepository.updateStageById(
    enquiryId,
    stage,
    updatedBy
  );
  if (!updated) {
    const err = new Error("Enquiry not found");
    err.status = 404;
    throw err;
  }
  return updated;
};

// Assign an enquiry to an admin (or unassign by passing null).
const updateAssignedTo = async (enquiryId, assignedTo, updatedBy) => {
  if (assignedTo === undefined) {
    const err = new Error("assignedTo is required (use null to unassign)");
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    const err = new Error("Invalid enquiry id");
    err.status = 400;
    throw err;
  }
  if (assignedTo !== null) {
    if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
      const err = new Error(
        "Invalid assignedTo: must be an Admin _id or null"
      );
      err.status = 400;
      throw err;
    }
    const admin = await AdminRepository.findById(assignedTo);
    if (!admin) {
      const err = new Error("Admin not found");
      err.status = 404;
      throw err;
    }
  }
  const updated = await EnquiryRepository.updateAssignedToById(
    enquiryId,
    assignedTo,
    updatedBy
  );
  if (!updated) {
    const err = new Error("Enquiry not found");
    err.status = 404;
    throw err;
  }
  return updated;
};

module.exports = {
  updateStage,
  updateAssignedTo,
};

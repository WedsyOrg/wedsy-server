const Admin = require("../models/Admin");

// Find an admin by _id. Returns the document or null.
const findById = async (_id) => {
  return await Admin.findById(_id);
};

// Find all admins. Excludes password field from response.
// Sorted by name ascending for stable dropdown ordering.
const findAll = async () => {
  return await Admin.find({}, { password: 0 }).sort({ name: 1 }).lean();
};

module.exports = {
  findById,
  findAll,
};

const Admin = require("../models/Admin");

// Find an admin by _id. Returns the document or null.
const findById = async (_id) => {
  return await Admin.findById(_id);
};

module.exports = {
  findById,
};

const AdminRepository = require("../repositories/AdminRepository");

// List all admins. Returns an array (possibly empty). Strips password by repository.
const listAdmins = async () => {
  return await AdminRepository.findAll();
};

module.exports = {
  listAdmins,
};

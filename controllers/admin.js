const AdminService = require("../services/AdminService");

// GET /admin
const GetAll = async (req, res) => {
  try {
    const admins = await AdminService.listAdmins();
    res.status(200).json(admins);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  GetAll,
};

const RoleService = require("../services/RoleService");

// GetAll — GET /role
const GetAll = async (req, res) => {
  try {
    const result = await RoleService.getAll();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  GetAll,
};

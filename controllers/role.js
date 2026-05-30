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

// UpdatePermissions — PUT /role/:id
const UpdatePermissions = async (req, res) => {
  try {
    const { permissions, description } = req.body || {};
    const updated = await RoleService.updatePermissions(req.params.id, { permissions, description });
    res.status(200).json(updated);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

module.exports = {
  GetAll,
  UpdatePermissions,
};

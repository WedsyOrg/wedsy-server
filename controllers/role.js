const RoleService = require("../services/RoleService");

// GetAll — GET /role
const GetAll = async (req, res) => {
  try {
    const result = await RoleService.getAll(req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UpdatePermissions — PUT /role/:id
const UpdatePermissions = async (req, res) => {
  try {
    const { permissions, description } = req.body || {};
    const updated = await RoleService.updatePermissions(req.params.id, { permissions, description }, req.auth.user_id);
    res.status(200).json(updated);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// Create — POST /role (Settings Suite: settings_roles gate on the route)
const Create = async (req, res) => {
  try {
    const created = await RoleService.createRole(req.body || {}, req.auth.user_id);
    res.status(201).json(created);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Server error" });
  }
};

// Delete — DELETE /role/:id (only when zero admins hold it)
const Delete = async (req, res) => {
  try {
    const result = await RoleService.deleteRole(req.params.id, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Server error" });
  }
};

module.exports = {
  GetAll,
  UpdatePermissions,
  Create,
  Delete,
};

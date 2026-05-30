const DepartmentService = require("../services/DepartmentService");

// GetAll — GET /department
const GetAll = async (req, res) => {
  try {
    const result = await DepartmentService.getAll();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  GetAll,
};

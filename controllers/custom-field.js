const CustomFieldService = require("../services/CustomFieldService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[custom-field]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// GET /custom-field?active=true — readable by any logged-in admin (the cockpit needs defs).
const GetAll = async (req, res) => {
  try {
    const defs = await CustomFieldService.listDefs({ activeOnly: req.query.active === "true" });
    res.status(200).json(defs);
  } catch (error) {
    respond(res, error);
  }
};

const Create = async (req, res) => {
  try {
    res.status(201).json(await CustomFieldService.createDef(req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const Update = async (req, res) => {
  try {
    res.status(200).json(await CustomFieldService.updateDef(req.params.id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const Delete = async (req, res) => {
  try {
    res.status(200).json(await CustomFieldService.deleteDef(req.params.id));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { GetAll, Create, Update, Delete };

const TriageService = require("../services/TriageService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

const List = async (req, res) => {
  try {
    res.status(200).json({ list: await TriageService.listTriage() });
  } catch (error) {
    respond(res, error);
  }
};

const Interns = async (req, res) => {
  try {
    res.status(200).json({ list: await TriageService.internsWithStatus() });
  } catch (error) {
    respond(res, error);
  }
};

const Assign = async (req, res) => {
  try {
    const toAdminId = (req.body || {}).adminId || req.auth.user_id; // omitted → take it myself
    res.status(200).json(await TriageService.assign(req.params._id, toAdminId, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Interns, Assign };

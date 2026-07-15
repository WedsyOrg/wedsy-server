// W6 — GET /team
const TeamReadService = require("../services/TeamReadService");

const Team = async (req, res) => {
  try {
    res.status(200).json(await TeamReadService.team(req.auth.user_id));
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load the team — please retry." : error.message });
  }
};

module.exports = { Team };

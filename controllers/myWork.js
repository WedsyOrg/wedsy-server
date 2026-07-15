// W2 — /my-work — the caller's merged action queue + schedule.
const MyWorkService = require("../services/MyWorkService");

// GET /my-work/now
const Now = async (req, res) => {
  try {
    res.status(200).json(await MyWorkService.now(req.auth.user_id));
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load your queue — please retry." : error.message });
  }
};

// GET /my-work/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
const Schedule = async (req, res) => {
  try {
    res.status(200).json(await MyWorkService.schedule(req.auth.user_id, { from: req.query.from, to: req.query.to }));
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not load your schedule — please retry." : error.message });
  }
};

module.exports = { Now, Schedule };

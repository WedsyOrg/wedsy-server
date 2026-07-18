// C2/C4 — /cs/* controllers (dashboard + Instagram planner).
const CsDashboardService = require("../services/CsDashboardService");
const ContentPostService = require("../services/ContentPostService");

const fail = (res, error, fallback) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? fallback : error.message });
};

// GET /cs/dashboard
const Dashboard = async (req, res) => {
  try {
    res.status(200).json(await CsDashboardService.dashboard(req.auth.user_id, req.csContext));
  } catch (error) {
    fail(res, error, "Could not load the CS dashboard — please retry.");
  }
};

// GET /cs/content
const ContentBoard = async (req, res) => {
  try {
    res.status(200).json(await ContentPostService.board());
  } catch (error) {
    fail(res, error, "Could not load the content board — please retry.");
  }
};

// POST /cs/content
const ContentCreate = async (req, res) => {
  try {
    res.status(201).json(await ContentPostService.create(req.body || {}, req.auth.user_id));
  } catch (error) {
    fail(res, error, "Could not create the post — please retry.");
  }
};

// PATCH /cs/content/:id
const ContentPatch = async (req, res) => {
  try {
    res.status(200).json(await ContentPostService.patch(req.params.id, req.body || {}));
  } catch (error) {
    fail(res, error, "Could not update the post — please retry.");
  }
};

// DELETE /cs/content/:id
const ContentDelete = async (req, res) => {
  try {
    res.status(200).json(await ContentPostService.remove(req.params.id));
  } catch (error) {
    fail(res, error, "Could not delete the post — please retry.");
  }
};

module.exports = { Dashboard, ContentBoard, ContentCreate, ContentPatch, ContentDelete };

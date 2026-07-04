const LeadBulkService = require("../services/LeadBulkService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadBulk]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// All bulk actions are scope-verified inside the service (out-of-scope ⇒ the
// whole batch is rejected). req.scopeFilter comes from requirePermission.
const Tag = async (req, res) => {
  try { res.status(200).json(await LeadBulkService.bulkTag(req.body || {}, req.auth.user_id, req.scopeFilter)); }
  catch (error) { respond(res, error); }
};
const Stage = async (req, res) => {
  try { res.status(200).json(await LeadBulkService.bulkStage(req.body || {}, req.auth.user_id, req.scopeFilter)); }
  catch (error) { respond(res, error); }
};
const Lost = async (req, res) => {
  try { res.status(200).json(await LeadBulkService.bulkLost(req.body || {}, req.auth.user_id, req.scopeFilter)); }
  catch (error) { respond(res, error); }
};
// SOFT DELETE — additionally gated to leads:delete:all (founder) at the route.
const Archive = async (req, res) => {
  try { res.status(200).json(await LeadBulkService.bulkArchive(req.body || {}, req.auth.user_id, req.scopeFilter)); }
  catch (error) { respond(res, error); }
};

module.exports = { Tag, Stage, Lost, Archive };

const LeaveService = require("../services/LeaveService");
const { dayKey } = require("../services/hrPolicy");

const respondErr = (res, error, label) => {
  const status = error && error.status ? error.status : 500;
  if (status >= 500) console.error(`[${label}]`, error && error.message, error);
  return res.status(status).send({ message: (error && error.message) || "error" });
};

// POST /leave — apply. Same-day applications are accepted and auto-rejected, so
// a 201 here does not mean "approved"; read status.
const Apply = async (req, res) => {
  try {
    const { type, days, reason, medicalCertificate } = req.body || {};
    const out = await LeaveService.apply({ type, days, reason, medicalCertificate }, req.auth.user_id);
    return res.status(201).send({ message: out.request.status, ...out });
  } catch (error) {
    return respondErr(res, error, "Leave:Apply");
  }
};

// GET /leave/me — my requests and my balances for the year.
const Me = async (req, res) => {
  try {
    const year = Number(req.query.year) || Number(dayKey().slice(0, 4));
    const [requests, balances, compOffs] = await Promise.all([
      LeaveService.listRequests({ adminId: req.auth.user_id }),
      LeaveService.balancesFor(req.auth.user_id, year),
      LeaveService.listCompOffs(req.auth.user_id),
    ]);
    return res.send({ year, balances, requests, compOffs });
  } catch (error) {
    return respondErr(res, error, "Leave:Me");
  }
};

// GET /leave — scoped list (own | team | department | all via buildScopeFilter).
const List = async (req, res) => {
  try {
    const { status, adminId } = req.query || {};
    return res.send({ list: await LeaveService.listRequests(req.scopeFilter || {}, { status, adminId }) });
  } catch (error) {
    return respondErr(res, error, "Leave:List");
  }
};

const Approve = async (req, res) => {
  try {
    const out = await LeaveService.decide(req.params.id, { approve: true, note: (req.body || {}).note }, req.auth.user_id);
    return res.send({ message: "approved", ...out });
  } catch (error) {
    return respondErr(res, error, "Leave:Approve");
  }
};

const Reject = async (req, res) => {
  try {
    const out = await LeaveService.decide(req.params.id, { approve: false, note: (req.body || {}).note }, req.auth.user_id);
    return res.send({ message: "rejected", ...out });
  } catch (error) {
    return respondErr(res, error, "Leave:Reject");
  }
};

const Cancel = async (req, res) => {
  try {
    return res.send({ message: "cancelled", request: await LeaveService.cancel(req.params.id, req.auth.user_id) });
  } catch (error) {
    return respondErr(res, error, "Leave:Cancel");
  }
};

// POST /leave/comp-off — record a weekly off that was worked.
const EarnCompOff = async (req, res) => {
  try {
    const { adminId, earnedFor, note } = req.body || {};
    const row = await LeaveService.earnCompOff(
      { adminId: adminId || req.auth.user_id, earnedFor, note },
      req.auth.user_id
    );
    return res.status(201).send({ message: "pending", compOff: row });
  } catch (error) {
    return respondErr(res, error, "Leave:EarnCompOff");
  }
};

const DecideCompOff = async (req, res) => {
  try {
    const grant = (req.body || {}).grant !== false;
    const row = await LeaveService.decideCompOff(req.params.id, { grant, note: (req.body || {}).note }, req.auth.user_id);
    return res.send({ message: grant ? "granted" : "rejected", compOff: row });
  } catch (error) {
    return respondErr(res, error, "Leave:DecideCompOff");
  }
};

module.exports = { Apply, Me, List, Approve, Reject, Cancel, EarnCompOff, DecideCompOff };

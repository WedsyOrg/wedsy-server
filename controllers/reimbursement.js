const ReimbursementService = require("../services/ReimbursementService");
const { MAX_BYTES } = require("../utils/receiptStore");

const respondErr = (res, error, label) => {
  const status = error && error.status ? error.status : 500;
  if (status >= 500) console.error(`[${label}]`, error && error.message, error);
  return res.status(status).send({ message: (error && error.message) || "error" });
};

const Create = async (req, res) => {
  try {
    const { amountClaimed, spentOn, category, note } = req.body || {};
    const claim = await ReimbursementService.createClaim({ amountClaimed, spentOn, category, note }, req.auth.user_id);
    return res.status(201).send({ message: "created", claim });
  } catch (error) { return respondErr(res, error, "Reimb:Create"); }
};

// POST /reimbursement/:id/receipt  (multipart, field "file")
// One file per call: a failed third upload must not lose the first two.
const AddReceipt = async (req, res) => {
  try {
    const f = req.files && (req.files.file || req.files.receipt);
    if (!f) return res.status(400).send({ message: 'Attach the receipt as multipart field "file"' });
    // express-fileupload truncates at the limit unless it aborts; catching the
    // flag means a half-file can never be stored as if it were whole.
    if (f.truncated) {
      return res.status(400).send({ message: `That file is over the ${MAX_BYTES / 1024 / 1024} MB limit` });
    }
    const claim = await ReimbursementService.addReceipt(
      req.params.id,
      { buffer: f.data, filename: f.name, declaredMime: f.mimetype },
      req.auth.user_id
    );
    return res.status(201).send({ message: "attached", claim });
  } catch (error) { return respondErr(res, error, "Reimb:AddReceipt"); }
};

const RemoveReceipt = async (req, res) => {
  try {
    const claim = await ReimbursementService.removeReceipt(req.params.id, (req.body || {}).url, req.auth.user_id);
    return res.send({ message: "removed", claim });
  } catch (error) { return respondErr(res, error, "Reimb:RemoveReceipt"); }
};

const Submit = async (req, res) => {
  try { return res.send({ message: "submitted", claim: await ReimbursementService.submit(req.params.id, req.auth.user_id) }); }
  catch (error) { return respondErr(res, error, "Reimb:Submit"); }
};

const Mine = async (req, res) => {
  try { return res.send({ list: await ReimbursementService.listMine(req.auth.user_id) }); }
  catch (error) { return respondErr(res, error, "Reimb:Mine"); }
};

const List = async (req, res) => {
  try { return res.send({ list: await ReimbursementService.listAll(req.scopeFilter || {}, { status: (req.query || {}).status }) }); }
  catch (error) { return respondErr(res, error, "Reimb:List"); }
};

const Decide = async (req, res) => {
  try {
    const { outcome, amountApproved, reason } = req.body || {};
    const claim = await ReimbursementService.decide(req.params.id, { outcome, amountApproved, reason }, req.auth.user_id);
    return res.send({ message: claim.status, claim });
  } catch (error) { return respondErr(res, error, "Reimb:Decide"); }
};

module.exports = { Create, AddReceipt, RemoveReceipt, Submit, Mine, List, Decide };

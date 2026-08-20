const DecorDraftService = require("../services/DecorDraftService");

// A2S ("Add to Store") — the approval queue endpoints. Every handler is
// try/catch'd: a failure must return a clear message to the extension, never a
// half-written draft.
const respondErr = (res, error, label) => {
  const status = error && error.status ? error.status : 500;
  if (status >= 500) console.error(`[${label}]`, error && error.message, error);
  const body = { message: (error && error.message) || "error" };
  // Structured hints the extension acts on (dedupe verdicts, force affordance).
  for (const k of ["code", "draftId", "productCode", "decorId", "canForce", "rejectionReason"]) {
    if (error && error[k] !== undefined) body[k] = error[k];
  }
  return res.status(status).send(body);
};

// POST /decor/drafts — the A2S click.
const Create = async (req, res) => {
  try {
    const { imageUrl, pinId, pinText, analysis, force } = req.body || {};
    const draft = await DecorDraftService.createDraft(
      { imageUrl, pinId, pinText, analysis, force: force === true },
      req.auth && req.auth.user_id
    );
    return res.status(201).send({ message: "queued", draft });
  } catch (error) {
    return respondErr(res, error, "A2S:Create");
  }
};

// GET /decor/drafts?status=queued&page=&limit=
const List = async (req, res) => {
  try {
    const { status, page, limit } = req.query || {};
    return res.send(await DecorDraftService.listDrafts({ status, page, limit }));
  } catch (error) {
    return respondErr(res, error, "A2S:List");
  }
};

// GET /decor/drafts/:id — full detail incl. the complete aiAnalysis.
const Get = async (req, res) => {
  try {
    return res.send(await DecorDraftService.getDraft(req.params.id));
  } catch (error) {
    return respondErr(res, error, "A2S:Get");
  }
};

// POST /decor/drafts/:id/approve
const Approve = async (req, res) => {
  try {
    const result = await DecorDraftService.approveDraft(
      req.params.id,
      req.body || {},
      req.auth && req.auth.user_id
    );
    return res.status(201).send({ message: "approved", ...result });
  } catch (error) {
    return respondErr(res, error, "A2S:Approve");
  }
};

// POST /decor/drafts/:id/copy — re-run the copy pass from the approvals queue.
// Not gated on canPublish: writing copy is not publishing, and the staff member
// who queued the pin should be able to ask for it again.
const RetryCopy = async (req, res) => {
  try {
    const result = await DecorDraftService.retryCopy(req.params.id);
    return res.send({ message: result.status || result.skipped || "done", ...result });
  } catch (error) {
    return respondErr(res, error, "A2S:RetryCopy");
  }
};

// POST /decor/drafts/:id/reject
const Reject = async (req, res) => {
  try {
    const draft = await DecorDraftService.rejectDraft(
      req.params.id,
      req.body || {},
      req.auth && req.auth.user_id
    );
    return res.send({ message: "rejected", draft });
  } catch (error) {
    return respondErr(res, error, "A2S:Reject");
  }
};

module.exports = { Create, List, Get, Approve, Reject, RetryCopy };

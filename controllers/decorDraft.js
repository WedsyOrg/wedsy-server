const DecorDraftService = require("../services/DecorDraftService");
const { adminHasPermission } = require("../middlewares/requirePermission");

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

// POST /decor/drafts/uploads — the bulk-upload intake.
//
// CONTRACT (multipart): files image_0..image_4, CONTIGUOUS from image_0, each
// with text fields category_i (required, a real catalogue category) and
// occasion_i (an OCCASIONS value, or empty for an explicit "none") beside it.
// The response is per-item: { batchId, results: [{ position, status:
// "queued"|"failed", draft?|error? }] } — position equals the field index.
// 201 when at least one item queued; 400 when every item failed.
const CreateUploads = async (req, res) => {
  try {
    const files = req.files || {};
    const body = req.body || {};
    const items = [];
    for (let i = 0; i < 5; i++) {
      const f = files[`image_${i}`];
      if (!f) break; // contiguous from 0 — a gap ends the batch
      const file = Array.isArray(f) ? f[0] : f;
      items.push({
        buffer: file.data,
        truncated: !!file.truncated,
        originalFilename: file.name || "",
        category: body[`category_${i}`],
        occasion: body[`occasion_${i}`],
      });
    }
    // Anything outside image_0..image_(n-1) means the client built the form
    // wrong — refuse loudly rather than silently dropping their file.
    const stray = Object.keys(files).filter(
      (k) => !/^image_[0-4]$/.test(k) || Number(k.slice(6)) >= items.length
    );
    if (!items.length || stray.length) {
      return res.status(400).send({
        message:
          "attach 1-5 images as multipart fields image_0..image_4, contiguous from image_0, with category_i and occasion_i beside each",
      });
    }
    const out = await DecorDraftService.createUploadBatch({ items }, req.auth && req.auth.user_id);
    const anyQueued = out.results.some((r) => r.status === "queued");
    return res
      .status(anyQueued ? 201 : 400)
      .send({ message: anyQueued ? "queued" : "no drafts created", ...out });
  } catch (error) {
    return respondErr(res, error, "A2S:CreateUploads");
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
    const doc = await DecorDraftService.getDraft(req.params.id);
    // Approvers get the document byte-for-byte. Everyone else loses ONLY the
    // full aiAnalysis — the internal evidence half (price ladder, comparables,
    // confidence gates). Sales still sees status, pricing.uploadQuote (its
    // no_quote reason included), the copy, and the history. Annotate, never
    // reject: a non-approver's request is answered, not refused.
    if (await adminHasPermission(req.auth && req.auth.user_id, "store:approve:all")) {
      return res.send(doc);
    }
    const { aiAnalysis, ...rest } = doc;
    return res.send(rest);
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

module.exports = { Create, CreateUploads, List, Get, Approve, Reject, RetryCopy };

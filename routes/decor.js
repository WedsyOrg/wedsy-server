const express = require("express");
const bodyParser = require("body-parser");
const router = express.Router();

const decor = require("../controllers/decor");
const decorDraft = require("../controllers/decorDraft");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Large parser only for the AI image upload route — base64 of a photo can be
// several MB, well past the default 100kb json limit.
const largeJson = bodyParser.json({ limit: "50mb" });

// A2S publish gate. Reuses the existing "approve" action verb — see the note in
// utils/rbacPermissions.js for why no "publish" verb was added.
const canPublish = requirePermission("store:approve:all");

router.post("/ai-analyze", largeJson, CheckAdminLogin, decor.AiAnalyze);
router.post("/ai-regenerate", CheckAdminLogin, decor.AiRegenerate);

// Phase A — pricing engine. Internal / team-only (JSON in, no image). Literal
// path — MUST stay above the "/:_id" routes so it isn't captured as an id.
router.post("/suggest-price", CheckAdminLogin, decor.SuggestPrice);

// Phase B — vision layer. base64 images can be several MB → largeJson. Literal
// path, above "/:_id". Admin-gated.
router.post("/analyse-image", largeJson, CheckAdminLogin, decor.AnalyseImage);

// Demo panel — live client pricing (vision demo → category → price ladder).
// largeJson for base64 images; literal path above "/:_id"; admin-gated.
router.post("/demo-price", largeJson, CheckAdminLogin, decor.DemoPrice);

// ── A2S ("Add to Store") queue ───────────────────────────────────────────────
// Literal paths — MUST stay above "/:_id" or GET /decor/drafts is captured as
// an id lookup. Creating/reading a draft needs admin auth only (any staff
// member can queue a pin); approve/reject need store:approve:all — the queue is
// meaningless if anyone can publish.
router.post("/drafts", largeJson, CheckAdminLogin, decorDraft.Create);
router.get("/drafts", CheckAdminLogin, decorDraft.List);
router.get("/drafts/:id", CheckAdminLogin, decorDraft.Get);
// Re-run the copy pass on a draft whose copy is pending or failed. Admin-only,
// NOT canPublish — asking the AI to write a name is not publishing a product.
router.post("/drafts/:id/copy", CheckAdminLogin, decorDraft.RetryCopy);
router.post("/drafts/:id/approve", CheckAdminLogin, canPublish, decorDraft.Approve);
router.post("/drafts/:id/reject", CheckAdminLogin, canPublish, decorDraft.Reject);

// ── Direct catalogue writes ─────────────────────────────────────────────────
// Gated on store:approve:all so the approval queue cannot be bypassed by
// posting straight to /decor. (Curation rides PUT /decor/:_id?addTo=, so the
// same route gate covers it.) GET stays public — unchanged.
router.post("/", CheckAdminLogin, canPublish, decor.CreateNew);
router.get("/", decor.GetAll);
// S3 — curation reorder (literal path — MUST stay above /:_id).
router.put("/reorder", CheckAdminLogin, canPublish, decor.Reorder);
// The AI analysis behind a published product — a REVERSE lookup into the draft
// that published it, never a copy. Two segments, so it cannot be captured by
// "/:_id"; kept above it anyway to match this file's convention. Admin-gated:
// it exposes the internal price ladder and who approved it.
router.get("/:_id/analysis", CheckAdminLogin, decor.DecorAnalysis);
router.get("/:_id", decor.Get);
router.put("/:_id", CheckAdminLogin, canPublish, decor.Update);
router.delete("/:_id", CheckAdminLogin, canPublish, decor.Delete);

module.exports = router;

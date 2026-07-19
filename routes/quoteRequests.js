// L4 — /quote-requests — the workspace-level quote queue (Store/CS teams).
// Ingest rides the internal seam; queue/patch are admin-gated.
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const { InternalOrAdmin } = require("../middlewares/internalAuth");
const leadPageV3 = require("../controllers/leadPageV3");

router.post("/ingest", InternalOrAdmin, leadPageV3.IngestQuoteRequest);
router.get("/", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), leadPageV3.QuoteQueue);
router.patch("/:id", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), leadPageV3.PatchQuoteRequest);

module.exports = router;

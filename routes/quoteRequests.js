// L4 — /quote-requests — the workspace-level quote queue (Store/CS teams).
// Ingest rides the internal seam; queue/patch are admin-gated.
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const { InternalOrAdmin } = require("../middlewares/internalAuth");
const leadPageV3 = require("../controllers/leadPageV3");

router.post("/ingest", InternalOrAdmin, leadPageV3.IngestQuoteRequest);

// S5 — the queue is ALSO the Wedding Store team's surface: a wedding_store
// department member (primary or hat) passes without any leads permission;
// everyone else falls through to the normal leads:view gate.
const leadsViewGate = requirePermission("leads:view:own", { ownerField: "assignedTo" });
const storeOrLeadsView = async (req, res, next) => {
  try {
    const { isDeptMember } = require("../services/CsAccessService");
    if (await isDeptMember("wedding_store", req.auth.user_id)) {
      req.scope = req.scope || "own";
      req.scopeFilter = req.scopeFilter || {};
      return next();
    }
  } catch (e) {
    console.error("[quoteRequests] store gate probe failed:", e.message);
  }
  return leadsViewGate(req, res, next);
};

router.get("/", CheckAdminLogin, storeOrLeadsView, leadPageV3.QuoteQueue);
router.patch("/:id", CheckAdminLogin, storeOrLeadsView, leadPageV3.PatchQuoteRequest);

module.exports = router;

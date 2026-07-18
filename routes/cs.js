// C2/C4 — /cs — the Client Servicing workspace (dashboard + Instagram
// planner). Gate: CS dept membership via hats, or founder / Revenue Head /
// a manager of CS members (CsAccessService.requireCs).
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requireCs } = require("../services/CsAccessService");
const cs = require("../controllers/cs");

router.get("/dashboard", CheckAdminLogin, requireCs, cs.Dashboard);
router.get("/content", CheckAdminLogin, requireCs, cs.ContentBoard);
router.post("/content", CheckAdminLogin, requireCs, cs.ContentCreate);
router.patch("/content/:id", CheckAdminLogin, requireCs, cs.ContentPatch);
router.delete("/content/:id", CheckAdminLogin, requireCs, cs.ContentDelete);

module.exports = router;

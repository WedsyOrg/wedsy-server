const express = require("express");
const router = express.Router();

const settings = require("../controllers/settings");
const { CheckAdminLogin } = require("../middlewares/auth");

// Category permission gates live INSIDE the controller — the gate depends on the
// requested category / key, which a route-level requirePermission cannot express.
router.get("/public", CheckAdminLogin, settings.GetPublic);
// Slice B5b — Agreement & Billing (whole-category read/write; founder-gated
// via settings_billing:edit:all inside the controller).
router.get("/billing", CheckAdminLogin, settings.GetBilling);
router.put("/billing", CheckAdminLogin, settings.PutBilling);
router.get("/", CheckAdminLogin, settings.GetCategory);
router.put("/", CheckAdminLogin, settings.Put);

module.exports = router;

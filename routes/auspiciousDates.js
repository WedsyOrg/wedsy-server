const express = require("express");
const router = express.Router();

const ctl = require("../controllers/auspiciousDates");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Auspicious (muhurat) dates — the platform's shared wedding-date calendar.
//
// Admin-JWT gated AND capability gated on `auspicious_dates_manage`: this is
// reference data every venue reads, so a wrong or vandalised entry mis-prices
// dates across the whole product. CheckAdminLogin alone (the classification the
// operational /admin/venues reads use) is not enough for a write surface with
// that blast radius.
//
// The READ that venue owners and members need is deliberately NOT here — it is
// GET /venues/:slug/auspicious-dates on the existing venue-owner surface, so no
// new unauthenticated route is opened.
router.get("/", CheckAdminLogin, requirePermission("auspicious_dates_manage:view:all"), ctl.listAuspiciousDates);
router.post("/", CheckAdminLogin, requirePermission("auspicious_dates_manage:create:all"), ctl.bulkCreateAuspiciousDates);
// BUILD4 — the review action, above /:id so "verify" is never read as an id.
// Marking a month checked is an EDIT of what those rows claim about themselves,
// so it takes the edit capability rather than create.
router.post("/verify", CheckAdminLogin, requirePermission("auspicious_dates_manage:edit:all"), ctl.verifyAuspiciousDates);
router.patch("/:id", CheckAdminLogin, requirePermission("auspicious_dates_manage:edit:all"), ctl.updateAuspiciousDate);
router.delete("/:id", CheckAdminLogin, requirePermission("auspicious_dates_manage:delete:all"), ctl.deleteAuspiciousDate);

module.exports = router;

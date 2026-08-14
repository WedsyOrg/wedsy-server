const express = require("express");
const router = express.Router();

const ctl = require("../controllers/weddingCalendarAdmin");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// BUILD4 — the rest of the wedding calendar: blackout periods and public
// holidays. Same gate as the muhurat dates (auspicious_dates_manage) because
// it is the same body of reference data entered by the same person; see
// controllers/weddingCalendarAdmin.js for why splitting the capability would
// be worse than sharing it.
//
// Mounted by routes/router.js under /admin/blackout-periods and
// /admin/public-holidays — both ABOVE /admin, or admin.js's param routes
// swallow the /:id forms.
function mount(prefix, handlers) {
  const r = express.Router();
  r.get("/", CheckAdminLogin, requirePermission("auspicious_dates_manage:view:all"), handlers.list);
  r.post("/", CheckAdminLogin, requirePermission("auspicious_dates_manage:create:all"), handlers.create);
  r.patch("/:id", CheckAdminLogin, requirePermission("auspicious_dates_manage:edit:all"), handlers.update);
  r.delete("/:id", CheckAdminLogin, requirePermission("auspicious_dates_manage:delete:all"), handlers.remove);
  router.use(prefix, r);
}

// The review queue — a read, so it takes the view capability.
router.get(
  "/wedding-calendar/review",
  CheckAdminLogin,
  requirePermission("auspicious_dates_manage:view:all"),
  ctl.reviewYear
);

mount("/blackout-periods", {
  list: ctl.listBlackoutPeriods,
  create: ctl.createBlackoutPeriod,
  update: ctl.updateBlackoutPeriod,
  remove: ctl.deleteBlackoutPeriod,
});

mount("/public-holidays", {
  list: ctl.listPublicHolidays,
  create: ctl.createPublicHolidays,
  update: ctl.updatePublicHoliday,
  remove: ctl.deletePublicHoliday,
});

module.exports = router;

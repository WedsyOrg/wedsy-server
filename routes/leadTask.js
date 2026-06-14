const express = require("express");
const router = express.Router();

const leadTask = require("../controllers/leadTask");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// MB7b Slice 2 — collaboration tasks. "mine" is registered BEFORE "/:_id/..."
// is irrelevant here (distinct paths), but kept explicit for clarity.
router.get(
  "/mine",
  CheckAdminLogin,
  requirePermission("leads:view:own"),
  leadTask.Mine
);
router.get(
  "/",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  leadTask.ListForLead
);
router.post(
  "/",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  leadTask.Create
);
router.put(
  "/:_id/complete",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  leadTask.Complete
);

module.exports = router;

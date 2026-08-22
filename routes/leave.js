const express = require("express");
const router = express.Router();

const controller = require("../controllers/leave");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Applying for your own leave, and seeing your own balances, needs no grant —
// same transparency rule as attendance /me. A person must always be able to see
// what they are entitled to and what they have used.
router.post("/", CheckAdminLogin, controller.Apply);
router.get("/me", CheckAdminLogin, controller.Me);
router.post("/:id/cancel", CheckAdminLogin, controller.Cancel);
router.post("/comp-off", CheckAdminLogin, controller.EarnCompOff);

// Seeing OTHER people's leave is scoped exactly like attendance: ownerField
// adminId lets buildScopeFilter resolve own → self, team → subordinates,
// department → members, all → everyone.
router.get("/", CheckAdminLogin, requirePermission("leave:view:own", { ownerField: "adminId" }), controller.List);

// Deciding is a separate action from viewing. The service additionally checks
// that the actor is on THIS request's approver list (or holds leave:approve:all),
// so the permission alone does not let someone approve outside their chain.
router.post("/:id/approve", CheckAdminLogin, requirePermission("leave:approve:own"), controller.Approve);
router.post("/:id/reject", CheckAdminLogin, requirePermission("leave:approve:own"), controller.Reject);
router.post("/comp-off/:id/decide", CheckAdminLogin, requirePermission("leave:approve:own"), controller.DecideCompOff);

module.exports = router;

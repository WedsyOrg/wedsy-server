const express = require("express");
const router = express.Router();

const controller = require("../controllers/payroll");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Everything here is salary data. There is no self-service view: a person's own
// pay is Razorpay's payslip, not this sheet, which carries the whole company's
// figures on one screen.
const canView = requirePermission("payroll:view:all");
const canApprove = requirePermission("payroll:approve:all");
const canExport = requirePermission("payroll:export:all");

router.get("/runs", CheckAdminLogin, canView, controller.ListRuns);
router.get("/salary/:adminId", CheckAdminLogin, canView, controller.SalaryHistory);
// Setting a salary is an approve-level act, not a view-level one.
router.post("/salary", CheckAdminLogin, canApprove, controller.SetSalary);

router.get("/:month", CheckAdminLogin, canView, controller.Sheet);
router.get("/:month/export", CheckAdminLogin, canExport, controller.Export);
router.post("/:month/item", CheckAdminLogin, canApprove, controller.ActOnItem);
router.post("/:month/incomplete", CheckAdminLogin, canApprove, controller.ConvertIncomplete);
router.post("/:month/finalise", CheckAdminLogin, canApprove, controller.Finalise);

module.exports = router;

const express = require("express");
const router = express.Router();

const { CheckLogin } = require("../middlewares/auth");
const payment = require("../controllers/payment");

router.get("/", CheckLogin, payment.GetAllPayments);
router.post("/", CheckLogin, payment.CreateNewPayment);
router.get("/:order_id/transactions", CheckLogin, payment.GetAllTransactions);
router.get("/:_id/invoice", CheckLogin, payment.GetInvoice);
router.put("/:order_id", CheckLogin, payment.UpdatePayment);

module.exports = router;

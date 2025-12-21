const express = require("express");
const router = express.Router();

const vendorPersonalLead = require("../controllers/vendor-personal-lead");
const {
  CheckVendorLogin,
  CheckLogin,
  CheckAdminLogin,
} = require("../middlewares/auth");

router.post("/", CheckVendorLogin, vendorPersonalLead.CreateNew);
router.get("/", CheckLogin, vendorPersonalLead.GetAll);
// Calendar helper endpoint (flattened personal-lead eventInfo entries)
router.get("/calendar", CheckLogin, vendorPersonalLead.GetCalendarEvents);
router.get("/:_id", CheckLogin, vendorPersonalLead.Get);
// Payment History: delete a single transaction
router.delete(
  "/:_id/transactions/:transactionId",
  CheckVendorLogin,
  vendorPersonalLead.DeleteTransaction
);
// Payment Reminder: send WhatsApp reminder + persist count
router.post(
  "/:_id/payment-reminder",
  CheckVendorLogin,
  vendorPersonalLead.SendPaymentReminder
);
router.put("/:_id", CheckVendorLogin, vendorPersonalLead.Update);
router.put(
  "/:_id/admin-notes",
  CheckAdminLogin,
  vendorPersonalLead.UpdateAdminNotes
);
router.delete("/:_id", CheckVendorLogin, vendorPersonalLead.Delete);

module.exports = router;

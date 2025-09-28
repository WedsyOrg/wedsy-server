const express = require("express");
const router = express.Router();

const settlements = require("../controllers/settlements");
const {
  CheckLogin,
  CheckAdminLogin,
  CheckVendorLogin,
} = require("../middlewares/auth");

router.post("/", CheckVendorLogin, settlements.CreateVendorSettlementAccount);
router.post(
  "/product",
  CheckVendorLogin,
  settlements.CreateVendorSettlementProduct
);
router.post("/transfer", CheckAdminLogin, settlements.CreateSettlement);
router.put(
  "/product",
  CheckVendorLogin,
  settlements.UpdateVendorSettlementProduct
);
router.get("/", CheckLogin, settlements.GetSettlementAccountStatus);
router.get("/transfer", CheckLogin, settlements.GetSettlements);

module.exports = router;

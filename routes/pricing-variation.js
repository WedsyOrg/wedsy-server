const express = require("express");
const router = express.Router();

const pricingVariation = require("../controllers/pricing-variation");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, pricingVariation.CreateNew);
router.get("/", CheckAdminLogin, pricingVariation.GetAll);
router.get("/:_id", CheckAdminLogin, pricingVariation.Get);
router.put("/:_id/revert", CheckAdminLogin, pricingVariation.Revert);

module.exports = router;

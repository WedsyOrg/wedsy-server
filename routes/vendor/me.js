const express = require("express");
const router = express.Router();

const { CheckLogin } = require("../../middlewares/auth");
const auth = require("../../controllers/auth");

// Vendor "me" endpoint (same payload as GET /auth/vendor)
router.get("/", CheckLogin, auth.GetVendor);

module.exports = router;


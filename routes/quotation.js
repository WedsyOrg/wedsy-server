const express = require("express");
const router = express.Router();

const quotation = require("../controllers/quotation");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckLogin, quotation.CreateNew);

module.exports = router;

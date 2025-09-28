const express = require("express");
const router = express.Router();

const stats = require("../controllers/stats");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.get("/", CheckLogin, stats.GetStatistics);
router.get("/list", CheckLogin, stats.GetStatisticsList);
router.post("/", CheckLogin, stats.AddStatLog);

module.exports = router;

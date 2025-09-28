const express = require("express");
const router = express.Router();

const task = require("../controllers/task");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, task.CreateNew);
router.get("/", CheckAdminLogin, task.GetAll);
router.get("/:_id", CheckAdminLogin, task.Get);
router.put("/:_id", CheckAdminLogin, task.Update);
router.put("/:_id/complete", CheckAdminLogin, task.CompleteTask);
router.delete("/:_id", CheckAdminLogin, task.Delete);

module.exports = router;

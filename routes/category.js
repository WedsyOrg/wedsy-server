const express = require("express");
const router = express.Router();

const category = require("../controllers/category");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, category.CreateNew);
router.get("/", category.GetAll);
router.get("/:_id", CheckAdminLogin, category.Get);
router.put("/:_id", CheckAdminLogin, category.Update);
router.delete("/:_id", CheckAdminLogin, category.Delete);

module.exports = router;

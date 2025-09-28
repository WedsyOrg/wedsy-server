const express = require("express");
const router = express.Router();

const decor = require("../controllers/decor");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, decor.CreateNew);
router.get("/", decor.GetAll);
router.get("/:_id", decor.Get);
router.put("/:_id", CheckAdminLogin, decor.Update);
router.delete("/:_id", CheckAdminLogin, decor.Delete);

module.exports = router;

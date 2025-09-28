const express = require("express");
const router = express.Router();

const tag = require("../controllers/tag");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, tag.CreateNew);
router.get("/", CheckAdminLogin, tag.GetAll);
router.get("/:_id", CheckAdminLogin, tag.Get);
router.put("/:_id", CheckAdminLogin, tag.Update);
router.delete("/:_id", CheckAdminLogin, tag.Delete);

module.exports = router;

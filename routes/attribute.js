const express = require("express");
const router = express.Router();

const attribute = require("../controllers/attribute");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, attribute.CreateNew);
router.get("/", CheckAdminLogin, attribute.GetAll);
router.get("/:_id", CheckAdminLogin, attribute.Get);
router.put("/:_id", CheckAdminLogin, attribute.Update);
router.put("/:_id/add", CheckAdminLogin, attribute.AddtoList);
router.put("/:_id/remove", CheckAdminLogin, attribute.RemoveFromList);
router.delete("/:_id", CheckAdminLogin, attribute.Delete);

module.exports = router;

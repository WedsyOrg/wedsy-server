const express = require("express");
const router = express.Router();

const community = require("../controllers/community");
const {
  CheckVendorLogin,
  CheckLogin,
  CheckAdminLogin,
} = require("../middlewares/auth");

router.post("/", CheckLogin, community.CreateNew);
router.get("/", CheckLogin, community.GetAll);
router.get("/:_id", CheckLogin, community.Get);
router.post("/:_id/reply", CheckLogin, community.AddReply);
router.post("/:_id/like", CheckLogin, community.AddLike);
router.post("/:_id/dis-like", CheckLogin, community.AddDisLike);
router.delete("/:_id/like", CheckLogin, community.RemoveLike);
router.delete("/:_id/dis-like", CheckLogin, community.RemoveDisLike);
router.delete("/:_id", CheckAdminLogin, community.Delete);
router.delete("/:_id/reply/:rid", CheckAdminLogin, community.DeleteReply);

module.exports = router;

const express = require("express");
const router = express.Router();

const bidding = require("../controllers/bidding");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckLogin, bidding.CreateNew);
router.post("/:_id/view/:bidId", CheckLogin, bidding.UserViewBiddingBid);
router.post("/:_id/accept/:bidId", CheckLogin, bidding.UserAcceptBiddingBid);
router.post("/:_id/reject/:bidId", CheckLogin, bidding.UserRejectBiddingBid);
router.get("/", CheckLogin, bidding.GetAll);
router.get("/:_id", CheckLogin, bidding.Get);
// Allow user to update own bidding requirements/events
router.put("/:_id", CheckLogin, bidding.Update);

// Route to create bidding bids for existing biddings (users and admins)
router.post("/:_id/create-bids", CheckLogin, bidding.CreateBiddingBidsForExisting);

// router.put("/:_id", CheckAdminLogin, bidding.Update);
// router.delete("/:_id", CheckAdminLogin, bidding.Delete);

module.exports = router;

const express = require("express");
const router = express.Router();

const order = require("../controllers/order");
const {
  CheckLogin,
  CheckAdminLogin,
  CheckVendorLogin,
} = require("../middlewares/auth");

router.post("/", CheckLogin, order.CreateOrder);
router.get("/", CheckLogin, (req, res) => {
  const { source, vendorId, sourceFilter } = req.query;
  // Admin vendor oversight: allow filtering orders by vendorId/source without triggering
  // vendor-only handlers (which require isVendor).
  if (req.auth?.isAdmin && (vendorId || sourceFilter)) {
    return order.GetAllOrders(req, res);
  }
  if (source === "Personal-Package") {
    order.GetVendorPersonalPackageBooking(req, res);
  } else if (source === "Wedsy-Package") {
    order.GetWedsyPackageBooking(req, res);
  } else if (source === "Bidding") {
    order.GetBiddingBids(req, res);
  } else if (source === "Packages") {
    order.GetPackageRequests(req, res);
  } else if (source === "upcoming-events") {
    order.GetVendorUpcomingEvents(req, res);
  } else if (source === "revenue") {
    order.GetVendorRevenue(req, res);
  } else if (source === "stats") {
    order.GetVendorStats(req, res);
  } else if (source === "follow-ups") {
    order.GetVendorFollowUps(req, res);
  } else if (source === "ongoing-order") {
    order.GetVendorOngoingOrder(req, res);
  } else if (source === "calls-list") {
    order.GetVendorCallsList(req, res);
  } else {
    order.GetAllOrders(req, res);
  }
});
router.get("/:_id", CheckLogin, order.GetOrder);

router.post("/:_id/complete", CheckLogin, order.MarkOrderCompleted);

// Bidding
router.post(
  "/:_id/accept-bidding-bid",
  CheckVendorLogin,
  order.AcceptBiddingBid
);
router.post(
  "/:_id/reject-bidding-bid",
  CheckVendorLogin,
  order.RejectBiddingBid
);

// Wedsy-Package
router.post(
  "/:_id/accept-wedsy-package-booking",
  CheckVendorLogin,
  order.AcceptWedsyPackageBooking
);
router.post(
  "/:_id/reject-wedsy-package-booking",
  CheckVendorLogin,
  order.RejectWedsyPackageBooking
);

// Personal package
router.post(
  "/:_id/accept-personal-package-booking",
  CheckVendorLogin,
  order.AcceptVendorPersonalPackageBooking
);
router.post(
  "/:_id/reject-personal-package-booking",
  CheckVendorLogin,
  order.AcceptVendorPersonalPackageBooking
);
module.exports = router;

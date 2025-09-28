const express = require("express");
const router = express.Router();

const { CheckLogin } = require("../middlewares/auth");
const user = require("../controllers/user");

router.get("/", CheckLogin, user.GetUser);
router.put("/", CheckLogin, user.UpdateUser);
router.get("/wishlist", CheckLogin, user.GetWishListAll);
router.get("/wishlist/:wishlist", CheckLogin, user.GetWishList);
router.post("/wishlist/:wishlist", CheckLogin, user.AddToWishList);
router.delete("/wishlist/:wishlist", CheckLogin, user.RemoveFromWishList);
router.get("/is-added-to-wishlist", CheckLogin, user.IsAddedToWishlist);
router.get("/saved-address", CheckLogin, user.GetUserSavedAddress);
router.post("/saved-address", CheckLogin, user.AddSavedAddress);

module.exports = router;

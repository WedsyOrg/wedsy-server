//express app
const express = require("express");
const router = express.Router();

//Check Route
router.get("/", function (req, res) {
  res.send("Hello from Wedsy Server. The Server is live!!");
});

//Importing other routes
router.use("/auth", require("./auth"));
router.use("/user", require("./user"));
router.use("/enquiry", require("./enquiry"));
router.use("/decor", require("./decor"));
router.use("/decor-package", require("./decor-package"));
router.use("/event", require("./event"));
router.use("/payment", require("./payment"));
router.use("/file", require("./file"));
router.use("/quotation", require("./quotation"));
router.use("/event-mandatory-question", require("./event-mandatory-question"));
router.use("/label", require("./label"));
router.use("/unit", require("./unit"));
router.use("/raw-material", require("./raw-material"));
router.use("/attribute", require("./attribute"));
router.use("/add-on", require("./add-on"));
router.use("/category", require("./category"));
router.use("/coupon", require("./coupon"));
router.use("/discount", require("./discount"));
router.use("/taxation", require("./taxation"));
router.use("/product-type", require("./product-type"));
router.use("/pricing-variation", require("./pricing-variation"));
router.use("/config", require("./config"));
router.use("/task", require("./task"));
router.use("/event-community", require("./event-community"));
router.use("/event-type", require("./event-type"));
router.use("/event-lost-response", require("./event-lost-response"));
router.use("/lead-lost-response", require("./lead-lost-response"));
router.use("/lead-interest", require("./lead-interest"));
router.use("/lead-source", require("./lead-source"));
router.use("/color", require("./color"));
router.use("/quantity", require("./quantity"));
router.use("/location", require("./location"));
router.use("/notification", require("./notification"));
router.use("/vendor", require("./vendor"));
router.use("/vendor-category", require("./vendor-category"));
router.use("/vendor-preferred-look", require("./vendor-preferred-look"));
router.use("/vendor-speciality", require("./vendor-speciality"));
router.use("/vendor-makeup-style", require("./vendor-makeup-style"));
router.use("/vendor-add-ons", require("./vendor-add-ons"));
router.use("/tag", require("./tag"));
router.use("/webhook", require("./webhook"));
router.use("/vendor-personal-lead", require("./vendor-personal-lead"));
router.use("/vendor-personal-package", require("./vendor-personal-package"));
router.use("/community", require("./community"));
router.use("/message", require("./message"));
router.use("/wedsy-package-category", require("./wedsy-package-category"));
router.use("/wedsy-package", require("./wedsy-package"));
router.use("/bidding", require("./bidding"));
router.use("/order", require("./order"));
router.use("/chat", require("./chat"));
router.use("/settlements", require("./settlements"));
router.use("/stats", require("./stats"));
router.use("/vendor-review", require("./vendor-review"));

module.exports = router;

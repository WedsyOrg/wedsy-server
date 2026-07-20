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
router.use("/project", require("./project")); // Lifecycle Slice D
router.use("/settings", require("./settings")); // Settings Suite
router.use("/custom-field", require("./custom-field")); // Settings Suite
router.use("/step-definition", require("./step-definition")); // MB8b journey steps
router.use("/decor", require("./decor"));
router.use("/decor-package", require("./decor-package"));
router.use("/search", require("./search"));
router.use("/event", require("./event"));
router.use("/event/:eventId/wedding-timeline", require("./weddingTimeline"));
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
// IMPORTANT: mount /vendor/auth and /vendor/me BEFORE /vendor to avoid /vendor/:_id capturing "auth" / "me"
router.use("/vendor/auth", require("./vendor/auth"));
router.use("/vendor/me", require("./vendor/me"));
router.use("/vendor", require("./vendor"));
router.use("/vendor-category", require("./vendor-category"));
router.use("/vendor-preferred-look", require("./vendor-preferred-look"));
router.use("/vendor-speciality", require("./vendor-speciality"));
router.use("/vendor-makeup-style", require("./vendor-makeup-style"));
router.use("/vendor-add-ons", require("./vendor-add-ons"));
router.use("/tag", require("./tag"));
router.use("/webhook", require("./webhook"));
router.use("/webhook", require("./whatsappAgent"));
router.use("/webhook", require("./instagramAgent"));
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
// MB-V2: Wedsy OS venues workspace — mounted ABOVE /admin so /admin/venues/*
// never leaks into admin.js's PUT /:id param route.
router.use("/admin/venues", require("./adminVenueOps"));
router.use("/admin", require("./admin"));
router.use("/department", require("./department"));
router.use("/role", require("./role"));
router.use("/org", require("./org")); // MB10 — org chart + permission matrix (read)
router.use("/stages", require("./stage"));
router.use("/activity", require("./activity"));
router.use("/venues/present", require("./venuePresent")); // MB-V2 P1 public present-mode (mounted above /venues)
router.use("/venues", require("./venue"));
router.use("/places", require("./places"));
router.use("/venue-owner", require("./venueOwner"));
router.use("/conversations", require("./conversation"));
router.use("/wa", require("./waConversation")); // Kiara admin chat API
router.use("/attendance", require("./attendance")); // HRMS brick #1 (MB5 Slice 2)
router.use("/calendar", require("./calendar")); // Team calendar + meeting mode + huddles (MB5 Slice 3)
router.use("/admin-notifications", require("./notifications")); // in-OS staff notifications (MB5)
router.use("/google", require("./google")); // Google Workspace (MB6 Slice 8 — dormant until env-wired)
router.use("/saved-views", require("./savedViews")); // per-user leads filter sets (MB6 Slice 9)
router.use("/onboarding", require("./onboarding")); // onboarding & money engine (MB7a)
router.use("/lead-tasks", require("./leadTask")); // collaboration tasks (MB7b Slice 2)
router.use("/nurture-templates", require("./nurtureTemplate")); // nurture library (MB7b Slice 4)
router.use("/me", require("./me")); // W1 — workspace switcher (caller-scoped)
router.use("/my-work", require("./myWork")); // W2 — merged action queue + schedule
router.use("/escalations", require("./escalations")); // W5 — escalations page read
router.use("/team", require("./team")); // W6 — team page read
router.use("/cs", require("./cs")); // C2/C4 — CS workspace (dashboard + planner)
router.use("/quote-requests", require("./quoteRequests")); // L4 — quote queue
router.use("/plan", require("./plan")); // Planner P1 — internal seam + discount decide

module.exports = router;

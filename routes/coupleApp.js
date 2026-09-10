// COUPLE APP § 06.2 — the couple-facing API, mounted at /wedding.
//
// TWO ENDPOINTS SO FAR, deliberately: they are the ones that prove the shape.
// The rest of § 06.2 is listed, with its contract, in docs/couple-app-api.md.
//
// EVERY route in this file carries BOTH gates (§ 06.4):
//   CoupleAuth        — a User token, on a wedding this person is actually on
//   RequireSection    — the section, at the level this endpoint needs
// A route added here without a section gate is a section the client's UI is the
// only thing hiding, which § 06.4 says is not a control.
//
// The wedding read itself has no section gate on purpose: being on the wedding
// IS the permission to see its date, its functions and its team. Every screen
// behind it is gated.
const express = require("express");
const router = express.Router();
const { CoupleAuth, CouplePerson } = require("../middlewares/coupleAuth");
const coupleApp = require("../controllers/coupleApp");

// BEFORE "/:id", or Express reads "mine" as a wedding id and answers 400.
// This is the only route here without a wedding: it is how the app finds one.
router.get("/mine", CouplePerson, coupleApp.GetMyWeddings);

router.get("/:id", CoupleAuth, coupleApp.GetWedding);
// Home is a digest of five sections, so it cannot be gated on ONE of them. It
// is gated at "on the wedding", and its CONTENTS are narrowed per section
// inside CoupleWeddingService.getHome: a member who cannot see payments gets
// no payment decision card and a null paid total, not a zero.
router.get("/:id/home", CoupleAuth, coupleApp.GetHome);


/**
 * Domain sub-routers. Each milestone owns one file so the four can be built
 * and merged independently; every one mounts under /wedding/:id.
 */
router.use("/", require("./coupleApp-people"));
router.use("/", require("./coupleApp-website"));
router.use("/", require("./coupleApp-money"));
router.use("/", require("./coupleApp-planning"));

module.exports = router;

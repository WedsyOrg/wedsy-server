const express = require("express");
const bodyParser = require("body-parser");
const router = express.Router();

const decor = require("../controllers/decor");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

// Large parser only for the AI image upload route — base64 of a photo can be
// several MB, well past the default 100kb json limit.
const largeJson = bodyParser.json({ limit: "50mb" });

router.post("/ai-analyze", largeJson, CheckAdminLogin, decor.AiAnalyze);
router.post("/ai-regenerate", CheckAdminLogin, decor.AiRegenerate);

router.post("/", CheckAdminLogin, decor.CreateNew);
router.get("/", decor.GetAll);
// S3 — curation reorder (literal path — MUST stay above /:_id).
router.put("/reorder", CheckAdminLogin, decor.Reorder);
router.get("/:_id", decor.Get);
router.put("/:_id", CheckAdminLogin, decor.Update);
router.delete("/:_id", CheckAdminLogin, decor.Delete);

module.exports = router;

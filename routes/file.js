const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const { CheckLogin } = require("../middlewares/auth");
const file = require("../controllers/file");

router.post("/", CheckLogin, fileUpload({ parseNested: true }), file.CreateNew);

module.exports = router;

const express = require("express");
const router = express.Router();

const search = require("../controllers/search");
const { CheckToken } = require("../middlewares/auth");

router.get("/", CheckToken, search.Search);

module.exports = router;



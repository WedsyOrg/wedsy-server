// Public, human-facing privacy pages. Mounted at /privacy.
//
// A THIRD CATEGORY, deliberately given its own file. The repo already splits
// Instagram routes by how a request proves itself: the webhook router is
// unauthenticated but signature-verified, /instagram-agent is admin-authed.
// This page is neither — it is a browser GET by a member of the public who has
// no Wedsy account and never will, holding nothing but a confirmation code.
//
// Putting it on the webhook router would break that router's one useful
// invariant (everything there is HMAC-verified before it acts) and would leave
// a human-readable page sitting under a path called /webhook. So it gets its
// own mount, and the reasoning lives here rather than in someone's memory.
//
// The confirmation code is the only credential. It is random per request and
// discloses nothing on its own: an unknown code is answered with a plain
// "not found", never with a hint about why.
const express = require("express");
const router = express.Router();
const { DeletionStatus } = require("../controllers/instagramPrivacy");

router.get("/instagram-data-deletion", DeletionStatus);

module.exports = router;

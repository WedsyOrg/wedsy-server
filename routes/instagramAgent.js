const express = require('express');
const router = express.Router();
const { VerifyWebhook, ReceiveMessage } = require('../controllers/instagramAgent');
const { Deauthorize, DataDeletion } = require('../controllers/instagramPrivacy');

router.get('/instagram-agent', VerifyWebhook);
router.post('/instagram-agent', ReceiveMessage);

// Meta app-review callbacks. THESE BELONG HERE, not on /instagram-agent's authed
// router, and the rule is the same one that kept the OAuth /callback off this
// file: what decides the home is HOW A REQUEST PROVES ITSELF.
//
//   this router  — Meta's own servers, unauthenticated, proven by a signature
//   /instagram-agent — a logged-in admin, proven by CheckAdminLogin
//
// The OAuth /callback went to the authed router because it is a step in an
// admin-initiated browser flow and proves itself with a state token we minted.
// These two are the opposite: server-to-server POSTs from Meta that no human
// starts, verified by HMAC against the app secret. Same test, opposite answer.
//
// The invariant that makes this file safe to reason about is that EVERY route
// on it is signature-verified before it touches anything. Both handlers below
// verify first and reject outright on failure. The human-facing status page is
// NOT signature-verified, so it deliberately lives elsewhere — see routes/privacy.js.
router.post('/instagram-agent/deauthorize', Deauthorize);
router.post('/instagram-agent/data-deletion', DataDeletion);

module.exports = router;

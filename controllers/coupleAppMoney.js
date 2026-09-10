// COUPLE APP — THE REGISTRY, THE WALLET AND PAYMENTS (§ 05.1, § 05.4, § 06.2).
//
// Same layering as controllers/coupleApp.js, coupleAppPeople.js and
// coupleAppWebsite.js: the route mounts the gates and the limiters, the
// controller calls a service and answers, the service owns the reads, the
// writes and the rules. Every handler is wrapped so no route in this file can
// throw out of an async callback (repo rule 5), and nothing here logs (rule 6)
// except the 500 path, which is what the other couple-app controllers do.
//
// AUTH IS NOT HERE for the couple's endpoints: middlewares/coupleAuth resolves
// the caller, RequireSection("registry" | "payments", …) refuses the section,
// and RequirePayout refuses anyone who is not one of the two people getting
// married. A handler below may assume its route's gate has already passed.
//
// AUTH IS NOT HERE for the two public ones either, and that is the point. What
// protects them is the withholding in CoupleRegistryRules.publicRegistryPayload,
// the per-IP-and-slug limiter in utils/coupleRegistryRateLimit.js, and the fact
// that a contribution can only ever move a gift's own total upwards.
const CoupleRegistryService = require("../services/CoupleRegistryService");
const CoupleContributionService = require("../services/CoupleContributionService");
const CoupleMoneyService = require("../services/CoupleMoneyService");
const CoupleLinkFetchService = require("../services/CoupleLinkFetchService");

const respond = (res, error, fallback) => {
  const status = error && error.status ? error.status : 500;
  if (status === 500) console.error("[coupleAppMoney]", error);
  res.status(status).send({
    error: status === 500 ? "server_error" : (error && error.code) || "error",
    message: status === 500 ? fallback : error.message,
    // A 422's per-field messages and a 409's `funded`/`price` ride along, so
    // the screen can point at the box that is wrong or say who got there first.
    ...((error && error.extra) || {}),
  });
};

// try/catch, once, for every route in this file (repo rule 5).
const wrap = (fn, fallback) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    respond(res, error, fallback);
  }
};

/* ── the registry (§ 05.1) — gated registry/view | registry/edit ──────────── */

/** GET /wedding/:id/registry */
const GetRegistry = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.get(req.couple));
}, "We could not open your gift registry — please retry.");

/**
 * POST /wedding/:id/registry/fetch-link { url }
 *
 * This is the one endpoint on the couple app that makes an outbound request to
 * an address a user chose, so everything about it that matters is in
 * services/CoupleLinkFetchService: the scheme, address and port guards, the
 * socket-level lookup that survives DNS rebinding, the byte cap and the
 * timeout. Every field of the answer is optional — a missing price and a
 * missing photograph are the ordinary case, and the screen lets the couple
 * correct all of it before anything is saved.
 */
const FetchLink = wrap(async (req, res) => {
  res.status(200).send(await CoupleLinkFetchService.fetchLink(req.body && req.body.url));
}, "We could not read that link — please add the gift by hand.");

/** PATCH /wedding/:id/registry { intro } — § 05.1's note above the gifts. */
const SaveNote = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.saveNote(req.couple, req.body));
}, "We could not save your note — please retry.");

/** POST /wedding/:id/registry/items */
const AddItem = wrap(async (req, res) => {
  res.status(201).send(await CoupleRegistryService.addItem(req.couple, req.body));
}, "We could not add that gift — please retry.");

/** PATCH /registry-items/:id — pin, price, title, image. */
const PatchItem = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.patchItem(req.couple, req.coupleTargetId, req.body));
}, "We could not save that change — please retry.");

/** DELETE /registry-items/:id — archived once money has arrived against it. */
const DeleteItem = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.removeGift(req.couple, "item", req.coupleTargetId));
}, "We could not remove that gift — please retry.");

/** POST /wedding/:id/registry/funds */
const AddFund = wrap(async (req, res) => {
  res.status(201).send(await CoupleRegistryService.addFund(req.couple, req.body));
}, "We could not start that fund — please retry.");

/** PATCH /registry-funds/:id */
const PatchFund = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.patchFund(req.couple, req.coupleTargetId, req.body));
}, "We could not save that change — please retry.");

/** DELETE /registry-funds/:id */
const DeleteFund = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.removeGift(req.couple, "fund", req.coupleTargetId));
}, "We could not remove that fund — please retry.");

/** PATCH /contributions/:id { thanked } — the couple thanks people, not rows. */
const ThankContribution = wrap(async (req, res) => {
  res.status(200).send(await CoupleRegistryService.thank(req.couple, req.coupleTargetId, req.body));
}, "We could not save that — please retry.");

/* ── the wallet and payments (§ 05.4) ─────────────────────────────────────── */

/** GET /wedding/:id/wallet — the balance is the ledger's sum, never a field. */
const GetWallet = wrap(async (req, res) => {
  res.status(200).send(await CoupleMoneyService.getWallet(req.couple));
}, "We could not open your wallet — please retry.");

/** POST /wedding/:id/wallet/claim — RequirePayout, never a section gate. */
const ClaimWallet = wrap(async (req, res) => {
  res.status(200).send(await CoupleMoneyService.claim(req.couple, req.body));
}, "We could not request that claim — please retry.");

/** GET /wedding/:id/payments — a bare array, as `api.payments()` reads it. */
const GetPayments = wrap(async (req, res) => {
  res.status(200).send(await CoupleMoneyService.listPayments(req.couple));
}, "We could not open your payments — please retry.");

/**
 * POST /payments/:id/pay { method, useWallet } — RequirePayout.
 *
 * `useWallet` is a boolean and the offset is the server's. Nothing in the body
 * reaches the arithmetic: CoupleRegistryRules.payBody emits two keys and
 * CoupleWalletService.applyWallet has no parameter an amount could arrive in.
 */
const PayPayment = wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(await CoupleMoneyService.pay(req.couple, req.coupleTargetId, req.body));
}, "We could not start that payment — please retry.");

/* ── the guest's registry (§ 06.2, § 06.4) — PUBLIC, unauthenticated ──────── */

/**
 * GET /registry/:slug — PUBLIC, SSR.
 *
 * The body carries the privacy state the page needs (`privacy.linkOnly`), and
 * this handler additionally sets `X-Robots-Tag` itself: the client's
 * <meta name="robots"> is a second belt, and the header is the one a crawler
 * that never runs JavaScript obeys.
 *
 * A gated registry is never cached anywhere shared — one guest's unlock must
 * not become everybody's.
 */
const GetPublicRegistry = wrap(async (req, res) => {
  const result = await CoupleContributionService.publicRegistry(req.params.slug, req);

  if (result.linkOnly || result.gated) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (result.gated) {
    res.setHeader("Cache-Control", "private, no-store, must-revalidate");
    res.setHeader("Vary", "Cookie, X-Site-Unlock");
  } else {
    // Short and shared: a registry page changes when a gift is taken, and a
    // stale progress bar for a minute is better than a thundering herd.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=120");
  }
  res.status(200).send(result.payload);
}, "We could not open that gift registry — please retry.");

/**
 * POST /registry/:slug/contribute — PUBLIC, rate-limited (§ 06.4).
 *
 * The Contribution, the wallet credit and the gift's running total move
 * together (§ 06.3); `walletCredited` in the answer is the server confirming
 * it happened, with nothing left for the couple to do.
 */
const Contribute = wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(await CoupleContributionService.contribute(req.params.slug, req.body, req));
}, "We could not send that gift — please try again.");

module.exports = {
  GetRegistry,
  FetchLink,
  SaveNote,
  AddItem,
  PatchItem,
  DeleteItem,
  AddFund,
  PatchFund,
  DeleteFund,
  ThankContribution,
  GetWallet,
  ClaimWallet,
  GetPayments,
  PayPayment,
  GetPublicRegistry,
  Contribute,
};

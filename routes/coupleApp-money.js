/**
 * Couple app — MONEY: the gift registry (§ 05.1), the Wedsy Wallet and
 * Payments (§ 05.4). Mounted from routes/coupleApp.js, which is mounted at
 * /wedding; the child and public routes are exported as `.itemRoutes` and
 * mounted at the API root by routes/router.js.
 *
 * Three routers, and the difference between them is the whole § 06.4 story:
 *
 *   `router` — /wedding/:id/…  Every route carries CoupleAuth AND a gate.
 *   `items`  — /registry-items/:id, /registry-funds/:id, /contributions/:id,
 *              /payments/:id/pay. No wedding id in the URL, so FromDocument
 *              discovers it from the row and hands over to the SAME CoupleAuth.
 *   public   — /registry/:slug and its contribute. UNAUTHENTICATED, by design:
 *              a guest tapped a link in WhatsApp and has no token, must never
 *              be given one, and is rate-limited instead.
 *
 * ── THE TWO GATES THAT MOVE MONEY ────────────────────────────────────────
 * `POST /wedding/:id/wallet/claim` and `POST /payments/:id/pay` mount
 * `RequirePayout` INSTEAD OF RequireSection("payments", "edit") — never in
 * addition to it. § 06.4: "`edit` on payments never implies the ability to
 * initiate a payout." That is structural here, not a check a call site could
 * forget: "payouts" is not one of the six grantable sections
 * (utils/coupleEnums.SECTION), SharedMember.access has no key for one, and
 * CouplePermissions.canInitiatePayout takes ONE argument and reads no access
 * map at all — it answers "is this one of the two people getting married".
 * A shared family member with all six sections at "edit" may reschedule and
 * annotate a payment, and cannot pay it or claim a rupee.
 *
 * ── THE WALLET'S GATE IS BOTH SECTIONS ───────────────────────────────────
 * docs/couple-app-api.md § 5 specifies `GET /wedding/:id/wallet` as
 * "registry / view + payments / view", and that is what `RequireEvery` below
 * enforces: the same balance is the strip on the Registry screen and the tile
 * on Payments, so seeing it means being allowed on both. The consequence — a
 * member with only one of the two loses that strip — is recorded in § Money.
 *
 * FromDocument is imported from routes/coupleApp-people.js rather than rewritten:
 * it is how every child route on this API resolves its wedding, and two
 * implementations of "which wedding does this row belong to" is exactly the
 * kind of second membership test § 06.4 is written to prevent.
 */
const express = require("express");

const { CoupleAuth, RequireSection, RequirePayout } = require("../middlewares/coupleAuth");
const { FromDocument } = require("./coupleApp-people");
const permissions = require("../services/CouplePermissions");
const { contributeLimiter } = require("../utils/coupleRegistryRateLimit");
const { siteReadLimiter } = require("../utils/coupleSiteRateLimit");

const RegistryItem = require("../models/RegistryItem");
const RegistryFund = require("../models/RegistryFund");
const Contribution = require("../models/Contribution");
const Payment = require("../models/Payment");

const money = require("../controllers/coupleAppMoney");

const router = express.Router({ mergeParams: true });
const items = express.Router({ mergeParams: true });

/**
 * EVERY one of these sections, at this level. Refuses with the FIRST one that
 * is short, so the screen can name the door that is actually shut.
 *
 * Mounted only on the wallet, which genuinely belongs to two screens. Anywhere
 * one section is the answer, RequireSection is the answer.
 */
const RequireEvery = (pairs) => (req, res, next) => {
  try {
    if (!req.couple) {
      return res.status(401).send({ error: "unauthenticated", message: "Please sign in again." });
    }
    for (let i = 0; i < pairs.length; i += 1) {
      const [section, level] = pairs[i];
      if (!permissions.can(req.couple, section, level)) {
        return res
          .status(403)
          .send(permissions.denial(section, level, permissions.levelFor(req.couple, section)));
      }
    }
    return next();
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not check your access — please retry." });
  }
};

/* ── loaders for the child routes ─────────────────────────────────────────── */

const loadItem = async (id) => {
  const doc = await RegistryItem.findById(id, { weddingId: 1, title: 1, funded: 1, price: 1 }).lean();
  return doc ? { doc, weddingId: doc.weddingId, kind: "registryItem" } : null;
};

const loadFund = async (id) => {
  const doc = await RegistryFund.findById(id, { weddingId: 1, title: 1, raised: 1, target: 1 }).lean();
  return doc ? { doc, weddingId: doc.weddingId, kind: "registryFund" } : null;
};

const loadContribution = async (id) => {
  const doc = await Contribution.findById(id, { weddingId: 1, guestName: 1, thanked: 1 }).lean();
  return doc ? { doc, weddingId: doc.weddingId, kind: "contribution" } : null;
};

/**
 * A Payment's wedding is `coupleApp.weddingId` — the denormalised, indexed
 * field the couple-app rows carry. A Payment that has NO `coupleApp.weddingId`
 * is a CRM or store row that was never part of the couple's schedule, and
 * returning null here means it 404s rather than being paid through this door.
 */
const loadPayment = async (id) => {
  const doc = await Payment.findById(id, { coupleApp: 1, status: 1, amount: 1, amountDue: 1, amountPaid: 1 }).lean();
  const weddingId = doc && doc.coupleApp && doc.coupleApp.weddingId;
  return weddingId ? { doc, weddingId, kind: "payment" } : null;
};

/* ── wedding-scoped routes ────────────────────────────────────────────────── */

/* Registry — § 05.1. `fetch-link` is an EDIT: it spends this server's network
   on an address the caller chose, so a member who may only look does not get
   to choose it. */
router.get("/:id/registry", CoupleAuth, RequireSection("registry", "view"), money.GetRegistry);
router.patch("/:id/registry", CoupleAuth, RequireSection("registry", "edit"), money.SaveNote);
router.post("/:id/registry/fetch-link", CoupleAuth, RequireSection("registry", "edit"), money.FetchLink);
router.post("/:id/registry/items", CoupleAuth, RequireSection("registry", "edit"), money.AddItem);
router.post("/:id/registry/funds", CoupleAuth, RequireSection("registry", "edit"), money.AddFund);

/* The wallet — one balance, two screens, both sections. */
router.get(
  "/:id/wallet",
  CoupleAuth,
  RequireEvery([["registry", "view"], ["payments", "view"]]),
  money.GetWallet
);
/* Money OUT. RequirePayout, instead of a section gate — see the header. */
router.post("/:id/wallet/claim", CoupleAuth, RequirePayout, money.ClaimWallet);

/* Payments — § 05.4. */
router.get("/:id/payments", CoupleAuth, RequireSection("payments", "view"), money.GetPayments);

/* ── child-resource routes (no wedding id in the URL) ─────────────────────── */

const ITEM_MISSING = "We could not find that gift.";
const FUND_MISSING = "We could not find that fund.";
const CONTRIBUTION_MISSING = "We could not find that gift.";
const PAYMENT_MISSING = "We could not find that payment.";

items.patch(
  "/registry-items/:id",
  FromDocument(loadItem, ITEM_MISSING),
  CoupleAuth,
  RequireSection("registry", "edit"),
  money.PatchItem
);
items.delete(
  "/registry-items/:id",
  FromDocument(loadItem, ITEM_MISSING),
  CoupleAuth,
  RequireSection("registry", "edit"),
  money.DeleteItem
);

items.patch(
  "/registry-funds/:id",
  FromDocument(loadFund, FUND_MISSING),
  CoupleAuth,
  RequireSection("registry", "edit"),
  money.PatchFund
);
items.delete(
  "/registry-funds/:id",
  FromDocument(loadFund, FUND_MISSING),
  CoupleAuth,
  RequireSection("registry", "edit"),
  money.DeleteFund
);

items.patch(
  "/contributions/:id",
  FromDocument(loadContribution, CONTRIBUTION_MISSING),
  CoupleAuth,
  RequireSection("registry", "edit"),
  money.ThankContribution
);

/* THE ONE THAT MOVES MONEY. RequirePayout, mounted instead of
   RequireSection("payments", "edit") — never alongside it. */
items.post(
  "/payments/:id/pay",
  FromDocument(loadPayment, PAYMENT_MISSING),
  CoupleAuth,
  RequirePayout,
  money.PayPayment
);

/* ── the guest's registry — PUBLIC, unauthenticated, rate-limited ─────────── */

/* The read reuses the website milestone's own generous read bucket: a guest
   reloading a registry is normal, a crawler enumerating slugs is not. The
   contribute has its own tighter bucket (utils/coupleRegistryRateLimit), keyed
   by the SAME ipAndSlug rule — one key implementation on this server, not two. */
items.get("/registry/:slug", siteReadLimiter, money.GetPublicRegistry);
items.post("/registry/:slug/contribute", contributeLimiter, money.Contribute);

router.use("/", items);

module.exports = router;
// routes/router.js already mounts this at the root, so the client's own paths
// (`/registry-items/:id`, `/payments/:id/pay`, `/registry/:slug`) are served.
module.exports.itemRoutes = items;
// Exported for tests/couple-money-permissions.test.js, which runs the REAL
// gates against a fabricated req.couple with no database at all.
module.exports.RequireEvery = RequireEvery;
module.exports.loadPayment = loadPayment;

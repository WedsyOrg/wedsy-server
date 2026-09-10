const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Event = require("../models/Event");
const SharedMember = require("../models/SharedMember");
const permissions = require("../services/CouplePermissions");
const { isId } = require("../utils/objectId");

/* COUPLE-APP AUTH — § 06.4.
 *
 * The couple's token is a USER token — `{ _id }`, the same one models/User signs
 * in with. It is not an admin token (`{ _id, isAdmin: true }`) and not a vendor
 * token, and this middleware refuses both: an admin who wants a couple's data
 * has the CRM, which reads the same Event document through its own gates.
 *
 * ── WHAT weddingId IS ──────────────────────────────────────────────────────
 * An Event._id. A couple's wedding IS the Event document — the record the CRM,
 * the admin event tool and the vendor apps already read. See
 * docs/couple-app-api.md § "How weddingId resolves".
 *
 * ── WHO IS ON A WEDDING ────────────────────────────────────────────────────
 *   • Event.user                          — the account it was created under
 *   • Event.coupleApp.partners[].user     — the other partner
 *         Both partners are full (§ 06.4). Neither is more equal.
 *   • An ACCEPTED, UN-REVOKED SharedMember whose `user` is this caller
 *         Their reach is whatever their six-section access map says, checked by
 *         RequireSection on every endpoint — never by the client.
 * Anyone else gets a 403, including a signed-in stranger who guessed an id.
 *
 * ── 401 vs 403 ─────────────────────────────────────────────────────────────
 * wedsy-user's lib/plan/api.js read() treats them differently and deliberately:
 * both mean "the server refused, never substitute the seed", but 401 sends the
 * couple to sign in again and 403 tells them a door is shut. So:
 *   401 — no token, a token that does not verify, a token that is not a User's
 *   403 — a real signed-in person who is not on this wedding, or is and lacks
 *         the section
 * Every refusal carries a body the client can render.
 */

const unauthenticated = (res, message) =>
  res.status(401).send({
    error: "unauthenticated",
    message: message || "Please sign in again.",
  });

/** Verify a bearer token. Resolves the payload, or null. */
const verify = (token) =>
  new Promise((resolve) => {
    jwt.verify(token, process.env.JWT_SECRET, (err, result) => resolve(err ? null : result));
  });

/**
 * Resolve a caller's standing on one wedding. Exported because the child-
 * resource routes (`PATCH /guests/:id`, `PATCH /tasks/:id`, …) discover their
 * weddingId from the document they are about to touch, not from the URL — and
 * they must run the SAME membership test, not a second one.
 *
 * @returns {{ok:true, couple:object} | {ok:false, status:number, body:object}}
 */
const resolveMembership = async (weddingId, userId) => {
  if (!isId(weddingId)) {
    return { ok: false, status: 400, body: { error: "bad_request", message: "That is not a wedding id." } };
  }
  const event = await Event.findById(weddingId).lean();
  if (!event) {
    return { ok: false, status: 404, body: { error: "not_found", message: "We could not find that wedding." } };
  }

  const me = String(userId);
  const partners = (event.coupleApp && event.coupleApp.partners) || [];
  const isPartner =
    (event.user && String(event.user) === me) ||
    partners.some((p) => p && p.user && String(p.user) === me);

  if (isPartner) {
    return {
      ok: true,
      couple: { userId: me, weddingId: String(weddingId), event, role: "partner", member: null },
    };
  }

  const member = await SharedMember.findOne({ weddingId, user: userId }).lean();
  // An invitation that was never opened, or one that was taken away, is not
  // access. permissions.isActiveMember is the one definition of "still in".
  if (!permissions.isActiveMember(member)) {
    return { ok: false, status: 403, body: permissions.denial(null, null, "none") };
  }

  return {
    ok: true,
    couple: { userId: me, weddingId: String(weddingId), event, role: "member", member },
  };
};

/** Which route param carries the wedding id, for the /wedding/:id family. */
const weddingIdFrom = (req) =>
  (req.params && (req.params.id || req.params.weddingId || req.params._id)) || null;

/**
 * The gate on every /wedding/:id route.
 *
 * Sets `req.couple` — { userId, user, weddingId, event, role, member } — and
 * `req.auth`, in the shape the rest of this repo's middlewares use, so a
 * couple-app controller can be read alongside any other controller here.
 */
const CoupleAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header) return unauthenticated(res, "Please sign in to open your wedding.");
    const token = header.split(" ")[1];
    if (!token || token === "null") return unauthenticated(res);

    const payload = await verify(token);
    if (!payload || !payload._id) return unauthenticated(res, "Your session expired — please sign in again.");
    // A couple's token, and nothing else. An admin or vendor token verifies
    // perfectly well and is still not a couple.
    if (payload.isAdmin || payload.isVendor) {
      return unauthenticated(res, "This is not a couple's session.");
    }

    const user = await User.findById(payload._id).lean();
    if (!user || user.blocked || user.deleted) return unauthenticated(res, "Please sign in again.");

    const resolved = await resolveMembership(weddingIdFrom(req), user._id);
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);

    req.couple = { ...resolved.couple, user };
    req.auth = { user_id: String(user._id), user, isAdmin: false, isVendor: false };
    return next();
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not open your wedding — please retry." });
  }
};

/**
 * SECTION ENFORCEMENT — § 06.4, "on every endpoint".
 *
 * Both partners pass everything. A shared member passes only where their
 * access map says so, and the refusal names the section so the screen can say
 * which door is shut rather than rendering a blank wedding.
 *
 *   router.get("/:id/guests", CoupleAuth, RequireSection("guests", "view"), …)
 *   router.post("/:id/guests", CoupleAuth, RequireSection("guests", "edit"), …)
 */
const RequireSection = (section, level) => (req, res, next) => {
  try {
    if (!req.couple) return unauthenticated(res);
    if (permissions.can(req.couple, section, level)) return next();
    return res
      .status(403)
      .send(permissions.denial(section, level, permissions.levelFor(req.couple, section)));
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not check your access — please retry." });
  }
};

/**
 * PAYOUT ENFORCEMENT — § 06.4, "`edit` on payments never implies the ability to
 * initiate a payout."
 *
 * Mount this on `POST /payments/:id/pay` and `POST /wedding/:id/wallet/claim`
 * INSTEAD OF RequireSection("payments", "edit") — not in addition to it. It
 * consults no access map, because there is no access map value that could
 * satisfy it: the six grantable sections do not include payouts and
 * SharedMember.access has no key for one. A shared family member with every
 * section at "edit" reads this refusal.
 */
const RequirePayout = (req, res, next) => {
  try {
    if (!req.couple) return unauthenticated(res);
    if (permissions.canInitiatePayout(req.couple)) return next();
    return res.status(403).send(permissions.payoutDenial());
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not check your access — please retry." });
  }
};

module.exports = { CoupleAuth, RequireSection, RequirePayout, resolveMembership, weddingIdFrom };

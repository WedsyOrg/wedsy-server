// COUPLE APP — GUESTS, TASKS AND FAMILY SHARING (§ 06.2).
//
// Same layering as controllers/coupleApp.js and the rest of this repo: the
// route mounts the gates, the controller does nothing but call a service and
// answer, and the service owns the reads and the arithmetic. Every handler is
// wrapped so no couple-app route can throw out of an async callback.
//
// AUTH AND PERMISSIONS ARE NOT HERE. middlewares/coupleAuth resolves the caller
// and refuses the wedding; RequireSection refuses the section and RequirePartner
// refuses members management (§ 06.4). A handler in this file may assume
// `req.couple` is a person entitled to what its route mounted, and — for the
// child-resource routes — that `req.coupleTarget` is a document on that same
// wedding, because that is how its weddingId was discovered in the first place.
const CoupleGuestService = require("../services/CoupleGuestService");
const CoupleTaskService = require("../services/CoupleTaskService");
const CoupleMemberService = require("../services/CoupleMemberService");

const respond = (res, error, fallback) => {
  const status = error && error.status ? error.status : 500;
  if (status === 500) console.error("[coupleAppPeople]", error);
  res.status(status).send({
    error: status === 500 ? "server_error" : (error && error.code) || "error",
    message: status === 500 ? fallback : error.message,
    // A 422's per-field messages and a 409's existing id ride along so the
    // screen can point at the box that is wrong rather than saying "something
    // went wrong" over a form the couple has just filled in.
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

/* ── guests (§ 05.2) ──────────────────────────────────────────────────────── */

/** GET /wedding/:id/guests ?side&rsvp&event&q */
const ListGuests = wrap(async (req, res) => {
  res.status(200).send(await CoupleGuestService.list(req.couple, req.query));
}, "We could not open your guest list — please retry.");

/**
 * GET /wedding/:id/guests/headcount
 *
 * § 06.3 invariant 1. The numbers come straight out of CoupleHeadcountService
 * — the same function Budget catering, the Home stat and the website tally
 * read. Nothing in this path recomputes them.
 */
const GuestHeadcount = wrap(async (req, res) => {
  res.status(200).send(await CoupleGuestService.headcount(req.couple));
}, "We could not count your guest list — please retry.");

/** POST /wedding/:id/guests */
const AddGuest = wrap(async (req, res) => {
  res.status(201).send(await CoupleGuestService.create(req.couple, req.body));
}, "We could not add that guest — please retry.");

/** PATCH /guests/:id */
const PatchGuest = wrap(async (req, res) => {
  res.status(200).send(await CoupleGuestService.update(req.couple, req.coupleTarget, req.body));
}, "We could not save that change — please retry.");

/** DELETE /guests/:id */
const DeleteGuest = wrap(async (req, res) => {
  res.status(200).send(await CoupleGuestService.remove(req.couple, req.coupleTarget));
}, "We could not remove that guest — please retry.");

/* ── tasks (§ 05.3) ───────────────────────────────────────────────────────── */

/** GET /wedding/:id/tasks — CoupleTask ∪ WeddingMilestone, read-only on the latter. */
const ListTasks = wrap(async (req, res) => {
  res.status(200).send(await CoupleTaskService.list(req.couple));
}, "We could not open your tasks — please retry.");

/** POST /wedding/:id/tasks — always a CoupleTask. */
const AddTask = wrap(async (req, res) => {
  res.status(201).send(await CoupleTaskService.create(req.couple, req.body));
}, "We could not add that task — please retry.");

/** PATCH /tasks/:id */
const PatchTask = wrap(async (req, res) => {
  res.status(200).send(await CoupleTaskService.update(req.couple, req.coupleTarget, req.body));
}, "We could not save that task — please retry.");

/** DELETE /tasks/:id */
const DeleteTask = wrap(async (req, res) => {
  res.status(200).send(await CoupleTaskService.remove(req.couple, req.coupleTarget));
}, "We could not remove that task — please retry.");

/* ── members (§ 05.5) ─────────────────────────────────────────────────────── */

/** GET /wedding/:id/members */
const ListMembers = wrap(async (req, res) => {
  res.status(200).send(await CoupleMemberService.list(req.couple));
}, "We could not open your shared access — please retry.");

/** POST /wedding/:id/members — { name, relation, access } */
const AddMember = wrap(async (req, res) => {
  res.status(201).send(await CoupleMemberService.create(req.couple, req.body));
}, "We could not invite them — please retry.");

/** PATCH /members/:id */
const PatchMember = wrap(async (req, res) => {
  res.status(200).send(await CoupleMemberService.update(req.couple, req.coupleTarget, req.body));
}, "We could not change what they can see — please retry.");

/** DELETE /members/:id — revoke, never a hard delete. */
const RemoveMember = wrap(async (req, res) => {
  res.status(200).send(await CoupleMemberService.remove(req.couple, req.coupleTarget));
}, "We could not remove their access — please retry.");

module.exports = {
  ListGuests,
  GuestHeadcount,
  AddGuest,
  PatchGuest,
  DeleteGuest,
  ListTasks,
  AddTask,
  PatchTask,
  DeleteTask,
  ListMembers,
  AddMember,
  PatchMember,
  RemoveMember,
};

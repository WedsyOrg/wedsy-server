/**
 * Couple app — PEOPLE: the guest list (§ 05.2), tasks (§ 05.3) and family
 * sharing (§ 05.5). Mounted from routes/coupleApp.js, which is mounted at
 * /wedding.
 *
 * EVERY route here carries BOTH gates (§ 06.4):
 *   CoupleAuth      — a User token, on a wedding this person is actually on
 *   RequireSection  — the section, at the level this endpoint needs
 *   RequirePartner  — for members management, which is not a grantable section
 * A route added here without one of them is a section the client's UI is the
 * only thing hiding, which § 06.4 says is not a control. Every handler is
 * wrapped in try/catch in controllers/coupleAppPeople.js; the middlewares in
 * this file wrap their own.
 *
 * ── THE CHILD-RESOURCE ROUTES ────────────────────────────────────────────
 * `PATCH /guests/:id`, `PATCH /tasks/:id` and `PATCH /members/:id` (and their
 * DELETEs) carry NO wedding id in the URL — wedsy-user's lib/plan/api.js calls
 * them with the row's own id and nothing else. They therefore discover their
 * weddingId FROM THE DOCUMENT they are about to touch, rewrite `:id` to it,
 * and then run the SAME middlewares/coupleAuth membership test as every other
 * route. Not a second test: the same one. See FromDocument below.
 *
 * ── WHERE THEY ARE REACHABLE ─────────────────────────────────────────────
 * The client's paths are root-level (`/guests/:id`), and this router is
 * mounted under /wedding, so today they answer at `/wedding/guests/:id`. The
 * child routes are exported separately as `.itemRoutes` so that one line in
 * routes/router.js — `router.use("/", require("./coupleApp-people").itemRoutes)`
 * — serves the client's exact paths without touching anything else. That line
 * is not added here because routes/router.js belongs to no one milestone; it
 * is written up in docs/couple-app-api.md § People.
 */
const express = require("express");

const { CoupleAuth, RequireSection } = require("../middlewares/coupleAuth");
const permissions = require("../services/CouplePermissions");
const rules = require("../services/CouplePeopleRules");
const { isId } = require("../utils/objectId");

const Guest = require("../models/Guest");
const CoupleTask = require("../models/CoupleTask");
const WeddingMilestone = require("../models/WeddingMilestone");
const SharedMember = require("../models/SharedMember");

const people = require("../controllers/coupleAppPeople");

const router = express.Router({ mergeParams: true });
const items = express.Router({ mergeParams: true });

/**
 * MEMBERS MANAGEMENT — partner only, and not by a check that could be
 * forgotten.
 *
 * "members" is deliberately not one of the six grantable sections
 * (utils/coupleEnums.SECTION), so SharedMember.access has no key for it and
 * CouplePeopleRules.accessMapFrom emits six keys and never a seventh. There is
 * no value in that document that could satisfy this gate — exactly the
 * structure RequirePayout relies on for money. A shared family member with all
 * six sections at "edit" cannot invite anybody, cannot raise their own access
 * and cannot revoke the person who let them in.
 *
 * Mounted INSTEAD OF RequireSection, never in addition to it.
 */
const RequirePartner = (req, res, next) => {
  try {
    if (!req.couple) {
      return res.status(401).send({ error: "unauthenticated", message: "Please sign in again." });
    }
    if (permissions.isPartner(req.couple)) return next();
    return res.status(403).send(rules.partnerDenial());
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not check your access — please retry." });
  }
};

/**
 * Discover a child resource's weddingId from the row itself, then hand over to
 * CoupleAuth.
 *
 * The token is refused BEFORE the lookup, with the body middlewares/coupleAuth
 * sends, so this route cannot be used by a signed-out stranger to probe which
 * ids exist. A signed-in stranger gets as far as CoupleAuth and is refused on
 * the wedding — which is the right refusal, and the same one they would get
 * from /wedding/:id.
 *
 * @param {(id:string)=>Promise<{doc:object, weddingId:*, kind:string}|null>} load
 * @param {string} missing  what to say when there is no such row
 */
const FromDocument = (load, missing) => async (req, res, next) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).send({ error: "unauthenticated", message: "Please sign in to open your wedding." });
    }
    const targetId = req.params.id;
    if (!isId(targetId)) return res.status(400).send({ error: "bad_request", message: missing });

    const found = await load(targetId);
    if (!found || !found.weddingId) return res.status(404).send({ error: "not_found", message: missing });

    req.coupleTarget = found.doc;
    req.coupleTargetKind = found.kind;
    req.coupleTargetId = targetId;
    // THE REWRITE. `:id` becomes the wedding the row belongs to, so the next
    // middleware is the ordinary CoupleAuth and this file never grows a second
    // membership test.
    req.params.id = String(found.weddingId);
    return next();
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not open that — please retry." });
  }
};

/**
 * A WRITE AIMED AT THE TEAM'S TIMELINE.
 *
 * GET /wedding/:id/tasks is the union of CoupleTask and WeddingMilestone, so a
 * milestone id is something the couple can legitimately see on their own Tasks
 * screen. It is not something they may change: those rows are the planner's,
 * rendered inside the CRM lead page, and every couple-app write lands on
 * CoupleTask.
 *
 * Mounted AFTER CoupleAuth and RequireSection on purpose. A stranger is
 * refused on the wedding first and never learns the row exists; only a member
 * who really can edit tasks is told whose task this one is.
 */
const RefuseMilestone = (req, res, next) => {
  try {
    if (req.coupleTargetKind === "milestone") return res.status(403).send(rules.milestoneDenial());
    return next();
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not open that task — please retry." });
  }
};

/* ── loaders ──────────────────────────────────────────────────────────────── */

const loadGuest = async (id) => {
  const doc = await Guest.findById(id, { weddingId: 1, phone: 1, phoneNormalised: 1, rsvp: 1, repliedAt: 1, first: 1, last: 1 }).lean();
  return doc ? { doc, weddingId: doc.weddingId, kind: "guest" } : null;
};

/**
 * A task id is one of two things. CoupleTask first — the couple's own
 * reminders are what these routes are for — and a WeddingMilestone second, so
 * the refusal above can name it rather than 404ing a row the couple can see.
 * The milestone's wedding is its `eventId`: the same Event document, its own
 * field name.
 */
const loadTask = async (id) => {
  const task = await CoupleTask.findById(id, { weddingId: 1, done: 1, title: 1 }).lean();
  if (task) return { doc: task, weddingId: task.weddingId, kind: "couple" };
  const milestone = await WeddingMilestone.findById(id, { eventId: 1, title: 1 }).lean();
  if (milestone) return { doc: milestone, weddingId: milestone.eventId, kind: "milestone" };
  return null;
};

const loadMember = async (id) => {
  const doc = await SharedMember.findById(id, { weddingId: 1, name: 1, revokedAt: 1 }).lean();
  return doc ? { doc, weddingId: doc.weddingId, kind: "member" } : null;
};

/* ── wedding-scoped routes ────────────────────────────────────────────────── */

/* Guests — § 05.2. The headcount is registered first for readability; it is a
   distinct path, not a shadowed one. */
router.get("/:id/guests/headcount", CoupleAuth, RequireSection("guests", "view"), people.GuestHeadcount);
router.get("/:id/guests", CoupleAuth, RequireSection("guests", "view"), people.ListGuests);
router.post("/:id/guests", CoupleAuth, RequireSection("guests", "edit"), people.AddGuest);

/* Tasks — § 05.3. The read is the union; the write is CoupleTask only. */
router.get("/:id/tasks", CoupleAuth, RequireSection("tasks", "view"), people.ListTasks);
router.post("/:id/tasks", CoupleAuth, RequireSection("tasks", "edit"), people.AddTask);

/* Family sharing — § 05.5. Partner only: see RequirePartner. */
router.get("/:id/members", CoupleAuth, RequirePartner, people.ListMembers);
router.post("/:id/members", CoupleAuth, RequirePartner, people.AddMember);

/* ── child-resource routes (no wedding id in the URL) ─────────────────────── */

const GUEST_MISSING = "We could not find that guest.";
const TASK_MISSING = "We could not find that task.";
const MEMBER_MISSING = "We could not find that person on your wedding.";

items.patch(
  "/guests/:id",
  FromDocument(loadGuest, GUEST_MISSING),
  CoupleAuth,
  RequireSection("guests", "edit"),
  people.PatchGuest
);
items.delete(
  "/guests/:id",
  FromDocument(loadGuest, GUEST_MISSING),
  CoupleAuth,
  RequireSection("guests", "edit"),
  people.DeleteGuest
);

items.patch(
  "/tasks/:id",
  FromDocument(loadTask, TASK_MISSING),
  CoupleAuth,
  RequireSection("tasks", "edit"),
  RefuseMilestone,
  people.PatchTask
);
items.delete(
  "/tasks/:id",
  FromDocument(loadTask, TASK_MISSING),
  CoupleAuth,
  RequireSection("tasks", "edit"),
  RefuseMilestone,
  people.DeleteTask
);

items.patch(
  "/members/:id",
  FromDocument(loadMember, MEMBER_MISSING),
  CoupleAuth,
  RequirePartner,
  people.PatchMember
);
items.delete(
  "/members/:id",
  FromDocument(loadMember, MEMBER_MISSING),
  CoupleAuth,
  RequirePartner,
  people.RemoveMember
);

router.use("/", items);

module.exports = router;
// Exported so routes/router.js can also serve them at the client's root-level
// paths (`/guests/:id`) with one line, whenever that file is next touched.
module.exports.itemRoutes = items;
// Exported for tests/couple-people-permissions.test.js, which runs the real
// gates against a fabricated req.couple with no database at all.
module.exports.RequirePartner = RequirePartner;
module.exports.RefuseMilestone = RefuseMilestone;
module.exports.FromDocument = FromDocument;

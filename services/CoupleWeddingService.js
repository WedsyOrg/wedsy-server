/* THE COUPLE-APP READS — GET /wedding/:id and GET /wedding/:id/home.
 *
 * The two endpoints that prove the shape. Everything they return is shaped to
 * what the finished frontend already renders: wedsy-user's lib/plan/api.js
 * (`api.wedding`, `api.home`) and the fixtures those screens were built
 * against in lib/plan/seed.js. A field renamed here is a screen that breaks.
 *
 * The arithmetic is NOT here. Headcount, the committed budget and the decisions
 * ranking each live in their own pure service and are called from here, so the
 * numbers on Home are the same numbers every other screen gets — that is the
 * whole of § 06.3 in one sentence.
 */

const Event = require("../models/Event");
const Guest = require("../models/Guest");
const Payment = require("../models/Payment");
const CoupleTask = require("../models/CoupleTask");
const WeddingMilestone = require("../models/WeddingMilestone");
const Website = require("../models/Website");
const ActivityLog = require("../models/ActivityLog");
const LeadTeamMember = require("../models/LeadTeamMember");
const Admin = require("../models/Admin");

const headcountService = require("./CoupleHeadcountService");
const decisionsService = require("./CoupleDecisionsService");
const activityService = require("./CoupleActivityService");
const finaliseService = require("./CoupleDecorFinaliseService");
const permissions = require("./CouplePermissions");
const { EVENT_KEY } = require("../utils/coupleEnums");

/* ── Shaping helpers (pure) ───────────────────────────────────────────────── */

/**
 * An Event day → the couple app's "function".
 *
 * `key` is derived from the day's NAME, because eventDays[] has never carried
 * one: the CRM lets a planner call a day anything. A day whose name is not one
 * of the five known functions keeps key "" and still renders — it is a real day
 * of a real wedding, not an error.
 */
const dayKey = (name) => {
  const value = String(name || "").trim().toLowerCase();
  const match = EVENT_KEY.find((key) => value === key || value.indexOf(key) !== -1);
  return match || "";
};

/**
 * A day's décor state (§ 06.1 DecorState), DERIVED — eventDays[] has never
 * carried a status field, and adding one would be a second copy of a truth the
 * day's own contents already hold:
 *
 *   finalised  the day is locked (status.finalized) — terminal, § 06.2
 *   priced     it has items and they carry prices
 *   drafted    it has items with no prices yet
 *   none       nothing drawn
 *
 * "needs_input" is NOT derivable: it means a human on the décor team is waiting
 * on the couple for a direction, and nothing on the Event records that yet. It
 * is listed in docs/couple-app-api.md as the one enum value the décor endpoints
 * must supply when they land — until then a day that needs a palette reads as
 * "drafted", which understates it rather than inventing it.
 */
const decorStateOf = (day) => {
  if (!day) return "none";
  if (day.status && day.status.finalized) return "finalised";
  const items = (day.decorItems || []).concat(day.packages || []);
  if (!items.length) return "none";
  return items.some((item) => Number(item && item.price) > 0) ? "priced" : "drafted";
};

const shapeDay = (day, guests) => {
  const key = dayKey(day && day.name);
  return {
    id: String((day && day._id) || ""),
    key,
    name: (day && day.name) || "",
    date: (day && day.date) || "",
    startTime: (day && day.time) || "",
    venue: (day && day.venue) || "",
    // § 06.3 "Events": defined once, consumed everywhere. The per-day number is
    // the guest list narrowed to this function — not a figure typed twice.
    expectedGuests: key ? headcountService.tallyForEvent(guests, key).headcount : 0,
    decorStatus: decorStateOf(day),
  };
};

/** A LeadTeamMember + their Admin → the couple app's team card. */
const shapeTeamMember = (row, admin) => ({
  id: String((admin && admin._id) || row.personId),
  name: (admin && admin.name) || "",
  // The couple reads a craft, not a department id. The department name is what
  // the roster already denormalises, lowercased for the client's role slugs.
  role: String(row.departmentName || "").toLowerCase(),
  // UNSTORED, HONESTLY EMPTY. The blurb, the quote, presence and response time
  // are real design fields (§ 03.1) with nowhere to live yet — see the "still
  // to build" list in docs/couple-app-api.md. Empty is a screen that renders
  // without them; invented copy is a lie in the couple's own app.
  blurb: "",
  quote: "",
  avatar: (admin && admin.meta && admin.meta.profilePhoto) || "",
  presence: null,
  responseTime: null,
});

/** A Payment row → the couple app's payment. */
const shapePayment = (payment) => {
  const couple = payment.coupleApp || {};
  return {
    id: String(payment._id),
    label: couple.label || "",
    vendor: couple.vendor || "",
    ref: couple.ref || "",
    amount: Number(payment.amount) || 0,
    dueDate: couple.dueDate || null,
    // The stored status is the gateway's; this is the one the screen shows.
    status: payment.status === "paid" ? "paid" : "due",
    paidAt: payment.status === "paid" ? payment.updatedAt : null,
    method: payment.paymentMethod === "default" ? "" : payment.paymentMethod,
    walletApplied: Number(couple.walletApplied) || 0,
  };
};

/** A CoupleTask → the client's task. */
const shapeTask = (task) => ({
  id: String(task._id),
  title: task.title,
  dueDate: task.dueDate,
  done: Boolean(task.done),
  remind: Boolean(task.remind),
  createdBy: task.createdByName || "",
  source: "couple",
});

/** A WeddingMilestone → the same shape, so the Tasks screen can hold both. */
const shapeMilestone = (milestone) => ({
  id: String(milestone._id),
  title: milestone.title,
  dueDate: milestone.dueDate,
  done: milestone.status === "COMPLETED",
  remind: false,
  createdBy: "Your planner",
  source: "milestone",
});

/* ── The reads ────────────────────────────────────────────────────────────── */

/**
 * GET /wedding/:id — the wedding, its functions and its team.
 *
 * @param {object} couple req.couple, as middlewares/coupleAuth resolved it
 */
const getWedding = async (couple) => {
  const event = couple.event;
  const weddingId = couple.weddingId;

  const [guests, website] = await Promise.all([
    Guest.find({ weddingId }, { party: 1, rsvp: 1, events: 1 }).lean(),
    Website.findOne({ weddingId }, { slug: 1 }).lean(),
  ]);

  // The team: the CURRENT roster on the lead this wedding came from
  // (activeTo: null is "still on the team"). A wedding with no lead — an OS
  // draft, or a couple who signed up directly — simply has no team yet.
  let team = [];
  if (event.leadId) {
    const roster = await LeadTeamMember.find({ leadId: event.leadId, activeTo: null }).lean();
    const admins = roster.length
      ? await Admin.find(
          { _id: { $in: roster.map((row) => row.personId) } },
          { name: 1, "meta.profilePhoto": 1 }
        ).lean()
      : [];
    const byId = new Map(admins.map((admin) => [String(admin._id), admin]));
    team = roster.map((row) => shapeTeamMember(row, byId.get(String(row.personId))));
  }

  const seesDecor = permissions.can(couple, "decor", "view");
  const seesPayments = permissions.can(couple, "payments", "view");
  const couples = (event.coupleApp && event.coupleApp.partners) || [];
  const budget = (event.coupleApp && event.coupleApp.budget) || {};
  const paid = await Payment.aggregate([
    { $match: { "coupleApp.weddingId": event._id, status: "paid" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return {
    id: String(event._id),
    slug: (website && website.slug) || null,
    city: (event.coupleApp && event.coupleApp.city) || "",
    weddingDate: event.eventDate || "",
    muhurthamTime: (event.coupleApp && event.coupleApp.muhurthamTime) || "",
    coverPhoto: (event.coupleApp && event.coupleApp.coverPhoto) || "",
    // § 06.4 — the money is behind a section like everything else. Décor view
    // carries the plan (estimate, target, committed); payments view carries
    // what has actually left the bank. A caller without them gets null, which
    // the client leaves out, rather than a 0 they would believe.
    budgetEstimate: seesDecor ? Number(budget.estimate) || 0 : null,
    budgetTarget: seesDecor ? Number(budget.target) || 0 : null,
    // § 06.3 — committed is Σ budget lines, never a stored total.
    budgetCommitted: seesDecor ? finaliseService.committedTotal(event) : null,
    budgetPaid: seesPayments ? (paid[0] && paid[0].total) || 0 : null,
    partners: couples.length
      ? couples.map((partner, index) => ({
          id: String(partner.user || `p${index + 1}`),
          name: partner.name || "",
          role: partner.role,
          phone: partner.phone || "",
          email: partner.email || "",
          avatar: partner.avatar || "",
        }))
      : // A wedding created before the couple app existed still has its two
        // names on the CRM record. Render those rather than an empty header.
        [
          { id: "bride", name: event.brideName || "", role: "bride", phone: "", email: "", avatar: "" },
          { id: "groom", name: event.groomName || "", role: "groom", phone: "", email: "", avatar: "" },
        ].filter((partner) => partner.name),
    events: (event.eventDays || []).map((day) => shapeDay(day, guests)),
    team,
    // § 06.4 — what THIS caller may do, so the client can render the right nav.
    // It renders it; it never decides it.
    viewer: {
      role: couple.role,
      access: permissions.accessMap(couple),
      canInitiatePayout: permissions.canInitiatePayout(couple),
    },
  };
};

/**
 * GET /wedding/:id/home — { decisions[], activity[], stats }.
 * Decisions capped at 3 and server-ranked (§ 06.3).
 */
const getHome = async (couple, now = new Date()) => {
  const event = couple.event;
  const weddingId = couple.weddingId;

  const [guests, payments, tasks, milestones, logs] = await Promise.all([
    Guest.find({ weddingId }, { party: 1, rsvp: 1, events: 1 }).lean(),
    Payment.find({ "coupleApp.weddingId": event._id }).lean(),
    CoupleTask.find({ weddingId }).lean(),
    WeddingMilestone.find({ eventId: event._id }).lean(),
    ActivityLog.find({ entityType: "wedding", entityId: String(weddingId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const tally = headcountService.tally(guests);
  const shapedPayments = payments.map(shapePayment);
  const openTasks = tasks
    .map(shapeTask)
    .concat(milestones.map(shapeMilestone))
    .filter((task) => !task.done);

  // § 06.4 ON THE DIGEST TOO. Home is a summary of five sections, so a shared
  // member who cannot see payments must not be handed a payment decision card
  // or a paid total by the one screen that summarises everything. The narrowing
  // happens HERE, on the server, not by the client choosing what to render.
  const seesPayments = permissions.can(couple, "payments", "view");
  const seesTasks = permissions.can(couple, "tasks", "view");
  const seesGuests = permissions.can(couple, "guests", "view");
  const seesDecor = permissions.can(couple, "decor", "view");

  const days = (event.eventDays || []).map((day) => shapeDay(day, guests));
  const ranked = decisionsService.rank(
    decisionsService.candidates({
      days: seesDecor ? days : [],
      payments: seesPayments ? shapedPayments : [],
      tasks: seesTasks ? openTasks : [],
      // Venue holds arrive with the venue endpoints (still to build); until
      // then this rule contributes nothing rather than inventing a hold.
      holds: [],
      now,
    }),
    now
  );

  return {
    decisions: ranked.decisions,
    activity: activityService.toDigest(logs, couple.userId, 4),
    // A stat this caller may not see is NULL, not 0. Zero is a number they
    // would believe; null is the client's cue to leave the tile out.
    stats: {
      headcount: seesGuests ? tally.headcount : null,
      invited: seesGuests ? tally.invited : null,
      replied: seesGuests ? tally.yes + tally.no : null,
      budgetTarget: seesDecor
        ? Number((event.coupleApp && event.coupleApp.budget && event.coupleApp.budget.target) || 0)
        : null,
      budgetCommitted: seesDecor ? finaliseService.committedTotal(event) : null,
      budgetPaid: seesPayments
        ? shapedPayments.reduce((sum, p) => (p.status === "paid" ? sum + p.amount : sum), 0)
        : null,
      openTasks: seesTasks ? openTasks.length : null,
      // The top bar's pill. Every blocking item, not the capped three — telling
      // a couple "3 open" when five are is a lie they find out about later.
      openDecisions: ranked.openCount,
      unreadActivity: activityService.unreadCount(logs, couple.userId),
    },
  };
};

module.exports = {
  getWedding,
  getHome,
  shapeDay,
  shapePayment,
  shapeTask,
  shapeMilestone,
  shapeTeamMember,
  decorStateOf,
  dayKey,
};

/* THE BUDGET (§ 3.2.3, § 06.2) — the estimate, the target and the tracker.
 *
 * ── THREE NUMBERS, AND WHO OWNS EACH ───────────────────────────────────────
 *
 *   estimate   what the wizard works out. Stored, so the Wedsy team opens the
 *              same figure the couple saw. Computed HERE, from the bands in
 *              services/CoupleBudgetRules — never taken from the request body.
 *   target     what the couple commits to. Theirs alone; the only one of the
 *              three a request may set.
 *   committed  Σ Event.coupleApp.budget.lines[].amount, and NOTHING ELSE.
 *              services/CoupleDecorFinaliseService.committedTotal is the one
 *              definition (§ 06.3 invariant 3) — there is no `committed` field
 *              on the model, so Home and this tracker have nothing to drift
 *              between. This file does not add one.
 *   paid       Σ paid Payment rows for this wedding, from
 *              CoupleScheduleService.paidTotal — the same aggregate the
 *              wedding read uses.
 *
 * ── THE TWO INPUTS A BODY MAY NOT NAME ─────────────────────────────────────
 * § 06.3 invariant 1: HEADCOUNT is server-computed and consumed by "Budget
 * catering". It is read here from the wedding's real Guest rows through
 * CoupleHeadcountService.tally and handed to the estimator — the client posts a
 * `headcount` and this file never reads it.
 *
 * § 06.3 "Events": the FUNCTIONS and their DATES are defined once on the Event.
 * The estimator is given the wedding's own days, narrowed to the ones the
 * couple ticked; a function this wedding does not have cannot buy a day of
 * catering, and `days` is the count of DISTINCT DATES, not of functions.
 */

const Event = require("../models/Event");
const Guest = require("../models/Guest");

const CoupleWeddingService = require("./CoupleWeddingService");
const headcountService = require("./CoupleHeadcountService");
const finaliseService = require("./CoupleDecorFinaliseService");
const scheduleService = require("./CoupleScheduleService");
const activityService = require("./CoupleActivityService");
const peopleRules = require("./CouplePeopleRules");
const budgetRules = require("./CoupleBudgetRules");
const rules = require("./CouplePlanningRules");

/** The wedding's functions, shaped once — § 06.3 "Events: defined once". */
const daysOf = (event, guests) =>
  (event.eventDays || []).map((day) => CoupleWeddingService.shapeDay(day, guests));

const budgetOf = (event) => (event.coupleApp && event.coupleApp.budget) || {};

/** GET /wedding/:id/budget — gated `decor / view`. */
const get = async (couple) => {
  const event = couple.event;
  const budget = budgetOf(event);
  const [guests, paid] = await Promise.all([
    Guest.find({ weddingId: couple.weddingId }, { party: 1, rsvp: 1, events: 1 }).lean(),
    scheduleService.paidTotal(couple.weddingId),
  ]);

  const tally = headcountService.tally(guests);

  return {
    estimate: Number(budget.estimate) || 0,
    target: Number(budget.target) || 0,
    // § 06.3 — committed is Σ lines, never a stored total.
    committed: finaliseService.committedTotal(event),
    paid,
    headcount: tally.headcount,
    answers: budget.estimateAnswers || {},
    lines: (budget.lines || []).map((line) => ({
      id: line.sourceKey,
      sourceKey: line.sourceKey,
      source: line.source || "",
      label: line.label || "",
      amount: rules.money(line.amount),
      at: line.at || null,
    })),
    // The five categories the tracker splits across, so the client's own
    // vocabulary and the server's cannot drift.
    categories: budgetRules.CATEGORIES,
  };
};

/**
 * POST /wedding/:id/budget/estimate — gated `decor / edit`.
 *
 * Stores the wizard's ANSWERS (§ 06.2) and the estimate THIS SERVER computed
 * from them. The client's own `estimate` and `headcount` are on the request and
 * reach no variable: CoupleBudgetRules.estimateAnswers is a whitelist that
 * emits only the keys the arithmetic reads, and the two figures that matter are
 * the server's.
 *
 * Deliberately not written to the feed. `api.estimateBudget` is fire-and-forget
 * and fires on every save of the target; the target itself is the decision, and
 * it is the one that is logged.
 */
const estimate = async (couple, body) => {
  const event = couple.event;
  const guests = await Guest.find({ weddingId: couple.weddingId }, { party: 1, rsvp: 1, events: 1 }).lean();
  const headcount = headcountService.tally(guests).headcount;

  const answers = budgetRules.estimateAnswers(body);
  const built = budgetRules.buildEstimate({
    answers,
    headcount,
    days: daysOf(event, guests),
  });

  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $set: {
        "coupleApp.budget.estimate": built.total,
        "coupleApp.budget.estimateAnswers": answers,
      },
    }
  );

  return {
    ok: true,
    estimate: built.total,
    total: built.total,
    categories: built.categories,
    days: built.days,
    seats: built.seats,
    headcount,
    functions: built.functions,
    cateringLines: built.cateringLines,
    decorLines: built.decorLines,
    serviceLines: built.serviceLines,
    answers,
  };
};

/** PUT /wedding/:id/budget/target { target } — gated `decor / edit`. */
const setTarget = async (couple, body) => {
  const target = budgetRules.targetFrom(body);
  if (target === null) {
    throw rules.validation({ target: "Give us a number to plan against." }, "That is not a budget.");
  }

  await Event.updateOne({ _id: couple.weddingId }, { $set: { "coupleApp.budget.target": target } });

  const actor = peopleRules.actorOf(couple);
  await activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action: "budget.target_set",
    objectType: "budget",
    objectId: couple.weddingId,
    summary: `Set the wedding budget to ₹${target.toLocaleString("en-IN")}`,
  });

  return { ok: true, target, committed: finaliseService.committedTotal(couple.event) };
};

module.exports = { get, estimate, setTarget, daysOf };

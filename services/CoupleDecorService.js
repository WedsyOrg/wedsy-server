/* THE DÉCOR JOURNEY (§ 3.2.2, § 06.2) — five states, one finalise.
 *
 * ── WHERE THE COUPLE'S DÉCOR ACTUALLY LIVES ────────────────────────────────
 * On the Event day (`eventDays[].decorItems`, `packages`, `customItems`,
 * `status.finalized`) and, for everything the couple has been SHOWN, in
 * models/PlanSnapshot — the publish membrane P2 built: "everything the couple
 * ever sees is a SNAPSHOT frozen at publish time; the working plan keeps moving
 * underneath without rewriting what was shown."
 *
 * This service reads that membrane and never goes around it. In particular:
 *
 *   · the looks the couple browses come from an `options` snapshot,
 *   · the comparable priced tiers come from a `comparison` snapshot and their
 *     itemisation from the `draft` snapshots behind it,
 *   · `pricingVisible: false` is HONOURED — § 3.2.2 state 2 is explicitly
 *     "looks only, no prices yet", and a snapshot published without pricing
 *     has its amounts withheld here rather than leaked by a screen that did
 *     not know to hide them.
 *
 * models/DecorDraft is NOT any of this. Despite the name it is the A2S
 * Pinterest→catalogue approval queue (docs/couple-app-api.md § 2), and this
 * file never touches it.
 *
 * ── THE FINALISE ───────────────────────────────────────────────────────────
 * The one irreversible act in the couple app. Every rupee, every due date,
 * every source key and the whole idempotence story is
 * services/CoupleDecorFinaliseService — called, never reimplemented — and the
 * writes are services/CoupleScheduleService, shared with the makeup accept.
 * There is no percentage and no schedule in this file.
 */

const Event = require("../models/Event");
const PlanSnapshot = require("../models/PlanSnapshot");
const Guest = require("../models/Guest");

const CoupleWeddingService = require("./CoupleWeddingService");
const decorState = require("./CoupleDecorStateService");
const finaliseService = require("./CoupleDecorFinaliseService");
const scheduleService = require("./CoupleScheduleService");
const activityService = require("./CoupleActivityService");
const peopleRules = require("./CouplePeopleRules");
const rules = require("./CouplePlanningRules");

/* ── reading the membrane ─────────────────────────────────────────────────── */

/** The most recent snapshot of each kind for this wedding's lead. */
const snapshotsFor = async (event) => {
  if (!event || !event.leadId) return {};
  const rows = await PlanSnapshot.find({ leadId: event.leadId }).sort({ at: -1 }).limit(40).lean();
  const latest = {};
  rows.forEach((row) => {
    if (!latest[row.kind]) latest[row.kind] = row;
  });
  return latest;
};

/**
 * A `comparison` snapshot + the `draft` snapshots behind it → the comparable
 * tiers § 3.2.2 state 4 puts side by side.
 *
 * `pricingVisible` gates every amount. When the team published the looks
 * without prices, `gross`, `discount`, `total` and every line amount are
 * ABSENT — not zeroed. A zero is a number the couple would read as free.
 */
const shapeDrafts = (comparison, drafts) => {
  if (!comparison) return [];
  const priced = Boolean(comparison.pricingVisible);
  const itemised = new Map(
    (drafts || []).map((snap) => [String((snap.content && snap.content.draftName) || snap.title || ""), snap])
  );

  return ((comparison.content && comparison.content.drafts) || []).map((row) => {
    const name = row.draftName || "";
    const behind = itemised.get(name);
    const days = (behind && behind.content && behind.content.days) || [];
    // The comparison snapshot's per-day rows come from utils/eventDecorPricing
    // .eventTotals — { dayId, name, date, total, … }. They are joined by NAME,
    // not by id: each priced tier is its own draft Event under the lead, so its
    // day ids are not the couple's Event's.
    const dayTotals = new Map((row.days || []).map((day) => [String(day.name || ""), day]));

    const shapedEvents = days.map((day) => {
      const totals = dayTotals.get(String(day.name || "")) || {};
      return {
        event: rules.eventKeyOf(day.name) || rules.slug(day.name),
        name: day.name || "",
        date: day.date || "",
        venue: day.venue || "",
        ...(priced ? { subtotal: rules.money(totals.total != null ? totals.total : totals.net) } : {}),
        items: (day.items || []).map((item) => ({
          label: item.name || "",
          detail: item.variant || item.category || "",
          qty: Number(item.quantity || 1),
          ...(priced ? { amount: rules.money(item.price) } : {}),
        })),
      };
    });

    return {
      id: rules.slug(name),
      name,
      tier: "",
      events: shapedEvents,
      ...(priced
        ? { gross: rules.money(row.gross), discount: rules.money(row.discount), total: rules.money(row.net) }
        : {}),
      // The per-day totals as the snapshot froze them — this is what a finalise
      // commits, so it is returned rather than recomputed anywhere.
      days: priced ? (row.days || []).map((day) => ({ ...day })) : [],
    };
  });
};

/** The looks the couple browses and hearts (§ 3.2.2 state 2). */
const shapeLooks = (options) =>
  ((options && options.content && options.content.looks) || []).map((look) => ({
    id: String(look.lookId || ""),
    name: look.name || "",
    photo: look.image || null,
    event: rules.eventKeyOf(look.functionKey),
    cat: look.categoryKey || "",
    mood: look.talkingPoint || "",
    // A price CHIP is what the team chose to show; it is a string, not a
    // figure this app derives, and it is only sent when pricing is visible.
    priceChip: options && options.pricingVisible ? look.priceChip || "" : "",
  }));

/** § 3.2.2 state 1 — the brief, read back to the couple, as the team froze it. */
const shapeBrief = (reveal) => {
  const blocks = (reveal && reveal.content && reveal.content.blocks) || [];
  return blocks
    .map((block) => (typeof block === "string" ? block : block && (block.text || block.title || "")))
    .filter(Boolean)
    .slice(0, 12);
};

/* ── the read ─────────────────────────────────────────────────────────────── */

/** GET /wedding/:id/decor — gated `decor / view`. */
const get = async (couple) => {
  const event = couple.event;
  const coupleDecor = (event.coupleApp && event.coupleApp.decor) || {};

  const [snapshots, guests] = await Promise.all([
    snapshotsFor(event),
    Guest.find({ weddingId: couple.weddingId }, { party: 1, rsvp: 1, events: 1 }).lean(),
  ]);

  const drafts = shapeDrafts(
    snapshots.comparison,
    snapshots.draft ? [snapshots.draft] : []
  );

  // Per-day state. The base four are CoupleWeddingService.decorStateOf's;
  // "needs_input" is the overlay this milestone owns.
  const days = (event.eventDays || []).map((day) => {
    const base = CoupleWeddingService.shapeDay(day, guests);
    return {
      ...base,
      decorStatus: decorState.stateOf(day, coupleDecor, base.key),
      needsInputReason: decorState.reasonFor(day, coupleDecor, base.key),
      tier: decorState.tierFor(coupleDecor, base.id),
      finalisedAt: decorState.dayStateOf(coupleDecor, base.id).finalisedAt || null,
    };
  });

  return {
    state: decorState.journeyState(days, coupleDecor),
    days,
    // `drafts` and `state` are what api.decor() names; everything else rides
    // alongside so no screen has to fetch twice.
    drafts,
    looks: shapeLooks(snapshots.options),
    brief: shapeBrief(snapshots.reveal),
    hearts: (coupleDecor.hearts || []).map((heart) => ({
      kind: heart.kind,
      id: heart.ref,
      event: heart.event || "",
      at: heart.at || null,
    })),
    tier: coupleDecor.tier || "",
    committed: finaliseService.committedTotal(event),
    finalised: days.length > 0 && days.every((day) => day.decorStatus === "finalised"),
    pricingVisible: Boolean(snapshots.comparison && snapshots.comparison.pricingVisible),
  };
};

/* ── the writes ───────────────────────────────────────────────────────────── */

const note = (couple, { action, objectId, summary }) => {
  const actor = peopleRules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "decor",
    objectId,
    summary,
  });
};

/**
 * POST /decor/:id/heart { themeId | productId } — gated `decor / edit`.
 *
 * A TOGGLE, because the client's control is one: `PlannerDecor.heart()` flips
 * `dxHearted` and posts the same body whether it is hearting or unhearting.
 * Two endpoints for one button would leave the two out of step the first time
 * a request was lost.
 *
 * Deliberately NOT written to the feed. A couple browsing a lookbook hearts a
 * dozen things in a minute, and twelve rows would push the venue hold, the
 * priced mandap and the guest import out of Home's four-item digest.
 */
const heart = async (couple, body) => {
  const heartRow = rules.heartFrom(body);
  const existing = ((couple.event.coupleApp && couple.event.coupleApp.decor && couple.event.coupleApp.decor.hearts) || [])
    .filter((row) => row);
  const already = existing.some((row) => row.kind === heartRow.kind && String(row.ref) === heartRow.ref);

  if (already) {
    await Event.updateOne(
      { _id: couple.weddingId },
      { $pull: { "coupleApp.decor.hearts": { kind: heartRow.kind, ref: heartRow.ref } } }
    );
    return { ok: true, hearted: false, ...heartRow };
  }

  // A lookbook is browsed, not curated: 200 is a generous ceiling and a stop
  // on a runaway client, not a limit anybody will reach by hand.
  if (existing.length >= 200) {
    throw rules.fail(409, "too_many_hearts", "That is a lot of looks — untick a few before adding more.");
  }
  await Event.updateOne(
    { _id: couple.weddingId },
    { $push: { "coupleApp.decor.hearts": { ...heartRow, at: new Date() } } }
  );
  return { ok: true, hearted: true, ...heartRow };
};

/**
 * POST /decor/:id/select-tier { tier } — gated `decor / edit`.
 *
 * A real decision the team acts on (§ 06.2), so it IS written to the feed.
 * When `:id` named one day, the tier is that day's; when it named the wedding
 * — which is what the finished client sends — it is the wedding's.
 */
const selectTier = async (couple, target, body) => {
  const tier = rules.tierFrom(body);
  const now = new Date();

  if (target && target.dayId) {
    const rows = ((couple.event.coupleApp && couple.event.coupleApp.decor && couple.event.coupleApp.decor.days) || []);
    const has = rows.some((row) => row && String(row.dayId) === String(target.dayId));
    if (has) {
      await Event.updateOne(
        { _id: couple.weddingId, "coupleApp.decor.days.dayId": String(target.dayId) },
        { $set: { "coupleApp.decor.days.$.tier": tier } }
      );
    } else {
      await Event.updateOne(
        { _id: couple.weddingId },
        { $push: { "coupleApp.decor.days": { dayId: String(target.dayId), tier } } }
      );
    }
  } else {
    await Event.updateOne(
      { _id: couple.weddingId },
      { $set: { "coupleApp.decor.tier": tier, "coupleApp.decor.tierAt": now } }
    );
  }

  await note(couple, {
    action: "decor.tier_selected",
    objectId: couple.weddingId,
    summary: `Chose the ${tier} décor`,
  });
  return { ok: true, tier, dayId: (target && target.dayId) || null };
};

/**
 * What one day commits, in rupees, and where the figure came from.
 *
 * ORDER MATTERS AND IS THE POINT. The frozen snapshot the couple actually
 * looked at comes first; the live draft on the Event is the fallback. A
 * finalise must commit the number that was on their screen, not one the
 * pricing engine moved to while they were reading it.
 */
const dayAmounts = (event, draft) => {
  const byName = new Map();
  ((draft && draft.days) || []).forEach((row) => {
    byName.set(String(row.name || ""), rules.money(row.total != null ? row.total : row.net));
  });

  const summary = new Map(
    ((event.amount && event.amount.summary) || []).map((row) => [String(row.eventDayId), rules.money(row.total)])
  );

  return (event.eventDays || []).map((day) => {
    const id = String(day._id);
    const fromSnapshot = byName.get(String(day.name || ""));
    return {
      dayId: id,
      name: day.name || "",
      amount: fromSnapshot !== undefined ? fromSnapshot : summary.get(id) || 0,
      source: fromSnapshot !== undefined ? "snapshot" : "event",
      alreadyFinalised: Boolean(day.status && day.status.finalized),
    };
  });
};

/**
 * POST /decor/:id/finalise — IRREVERSIBLE (§ 06.2). Gated `decor / edit`.
 *
 * The whole of § 06.3 invariant 3, called and not reimplemented:
 *
 *   CoupleDecorFinaliseService.plan()  decides the budget line, the schedule
 *                                      and the source keys, per day, folding
 *                                      each day's result into the next so the
 *                                      budget array is upserted once
 *   CoupleScheduleService.apply()      performs the two writes, upserting on
 *                                      the unique { weddingId, sourceKey }
 *
 * `alreadyFinalised` comes back as a VALUE. A couple who tapped twice has
 * finalised, and the second answer equals the first.
 *
 * The couple is never allowed to commit to a number other than the one they
 * were shown: when the request carries the total from the ceremony and the
 * server's figure differs, this refuses with `409 price_changed` naming both,
 * rather than quietly committing the larger one.
 */
const finalise = async (couple, target, body, now = new Date()) => {
  const confirm = rules.finaliseFrom(body);
  const event = couple.event;

  const snapshots = await snapshotsFor(event);
  const drafts = shapeDrafts(snapshots.comparison, snapshots.draft ? [snapshots.draft] : []);
  const coupleDecor = (event.coupleApp && event.coupleApp.decor) || {};
  const wanted = confirm.tier || coupleDecor.tier || "";
  const chosen =
    drafts.find((draft) => draft.id === rules.slug(wanted) || draft.name === wanted) || drafts[0] || null;

  const rows = dayAmounts(event, chosen)
    .filter((row) => !target || !target.dayId || String(row.dayId) === String(target.dayId))
    // A day priced at nothing has nothing to finalise. Without this it still
    // earned a ₹0 budget line — a row in the couple's budget that means
    // nothing, and one the payment schedule already (correctly) skipped, so
    // the two disagreed about how many days had been committed to.
    .filter((row) => row.amount > 0);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  if (!total) {
    throw rules.fail(
      422,
      "nothing_priced",
      "There is nothing priced to finalise yet — your décor team is still working on it."
    );
  }
  if (confirm.shownTotal && confirm.shownTotal !== total) {
    throw rules.fail(409, "price_changed", "The price changed while you were reading it — please look again.", {
      shown: confirm.shownTotal,
      now: total,
    });
  }

  // Fold each day's plan into the next: plan() returns the WHOLE budget array
  // after its upsert, so threading it is what makes four days one write.
  let working = event;
  let scheduleRows = [];
  let budgetLines = ((event.coupleApp && event.coupleApp.budget && event.coupleApp.budget.lines) || []).slice();
  let everyDayAlready = true;
  let committed = finaliseService.committedTotal(event);

  rows.forEach((row) => {
    const planned = finaliseService.plan({
      event: working,
      dayId: row.dayId,
      amount: row.amount,
      label: `${row.name || "Décor"} — décor`,
      vendor: "Wedsy",
      now,
    });
    if (!planned.alreadyFinalised) everyDayAlready = false;
    budgetLines = planned.budgetLines;
    committed = planned.committed;
    scheduleRows = scheduleRows.concat(planned.scheduleRows);
    working = {
      ...working,
      coupleApp: {
        ...(working.coupleApp || {}),
        budget: { ...((working.coupleApp || {}).budget || {}), lines: budgetLines },
      },
    };
  });

  const applied = await scheduleService.apply({
    planned: { budgetLines, scheduleRows, committed, alreadyFinalised: everyDayAlready },
    weddingId: couple.weddingId,
    userId: event.user || couple.userId,
    source: "decor",
    ref: "",
  });

  // The day itself is now the committed bill of materials. `status.finalized`
  // is the field CoupleWeddingService.decorStateOf already reads for
  // "finalised", so the state follows from the write rather than from a second
  // flag; `locked`/`finalisedBy` are models/Event's own documented lock, and
  // "couple" is a value its enum already carries.
  const finalisedIds = rows.map((row) => String(row.dayId));
  await Promise.all(
    finalisedIds.map((dayId) =>
      Event.updateOne(
        { _id: couple.weddingId, "eventDays._id": dayId },
        { $set: { "eventDays.$.status.finalized": true } }
      )
    )
  );
  if (!target || !target.dayId) {
    await Event.updateOne(
      { _id: couple.weddingId },
      { $set: { locked: true, lockedAt: now, finalisedBy: "couple" } }
    );
  }
  /* The décor team is no longer waiting on a day that is locked. Guarded on
     there actually BEING a row to touch: an arrayFilters update against a path
     that does not exist on the document is an error, and most weddings have
     never had a question raised on them. */
  const raised = ((event.coupleApp && event.coupleApp.decor && event.coupleApp.decor.days) || []).filter(
    (row) => row && finalisedIds.indexOf(String(row.dayId)) !== -1
  );
  if (raised.length) {
    await Event.updateOne(
      { _id: couple.weddingId },
      { $set: { "coupleApp.decor.days.$[row].needsInput": false, "coupleApp.decor.days.$[row].finalisedAt": now } },
      { arrayFilters: [{ "row.dayId": { $in: finalisedIds } }] }
    );
  }

  await note(couple, {
    action: "decor.finalised",
    objectId: couple.weddingId,
    summary: `Finalised the décor — ${chosen ? chosen.name : "your plan"}`,
  });

  /* ⛏ NOTIFICATION TRIGGER — NOT ADDED (project hard rule: triggers only,
   * through services/NotificationService.js, WhatsApp via the Meta Cloud API,
   * never Aisensy, and only after reading the Notification System spec in
   * Notion). The moment: the couple finalises their décor — the one
   * irreversible act in the app, and the one the décor team must hear about
   * within the minute. The trigger this wants is `couple_decor_finalised`, to
   * the décor lead and the lead planner, with the committed total. The in-app
   * Activity row above is the couple's half and stands alone. */

  return {
    ok: true,
    alreadyFinalised: applied.alreadyFinalised,
    committed: applied.committed,
    tier: chosen ? chosen.id : "",
    days: finalisedIds,
    scheduleRows: applied.rows,
    atomic: applied.atomic,
  };
};

module.exports = { get, heart, selectTier, finalise, shapeDrafts, shapeLooks, shapeBrief, dayAmounts, snapshotsFor };

/**
 * controllers/venueQuoteRound.js — the negotiation log.
 *
 * The Money tab used to be two numbers: their budget and our quote. It said
 * nothing about how the deal moved, so the state of a live negotiation lived
 * only in the owner's head. This records it: what we quoted, on what terms, why
 * (privately), how we sent it, what they said back, and what happened next.
 *
 * SCOPE. Every handler resolves the parent lead through utils/venueLeadScope
 * FIRST, so a round is exactly as private as the lead it belongs to and a
 * member who cannot open the lead gets a 404 — never a 403, which would confirm
 * the lead exists.
 *
 * CAPABILITY. Gated on `bookings_money`. The brief asked for `money_negotiate`
 * "where it exists" — it does not exist in this codebase, and inventing a
 * capability that no role bundle grants would lock every non-owner out of the
 * feature on day one. `bookings_money` is the money gate the product already
 * has, and pricing is squarely money.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueQuote = require("../models/VenueQuote");
const VenueTask = require("../models/VenueTask");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { syncQuotedValue } = require("../utils/venueQuotedValue");
const { resolveActorMemberId } = require("../utils/venueOwnerMember");
const { optNumber, optDate, optStr, cleanStr, MAXLEN } = require("../utils/venueInput");

const SENT_VIA = ["call", "whatsapp", "email", "in_person", "pdf", ""];
const OUTCOMES = ["pending", "accepted", "rejected", "countered", "silent"];
const MAX_ROUNDS = 100;

const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

/** Venue + scoped lead, or the error response. */
async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id state city settings").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) { res.status(404).json({ message: "Lead not found" }); return null; }
  return { venue, lead };
}

/** A round by id, already proven to belong to a lead this requester may see. */
async function resolveOwnedRound(req, res) {
  const owned = await resolveOwnedLead(req, res);
  if (!owned) return null;
  if (!mongoose.isValidObjectId(req.params.roundId)) {
    res.status(404).json({ message: "Round not found" });
    return null;
  }
  const round = await VenueQuoteRound.findOne({ _id: req.params.roundId, enquiry: owned.lead._id });
  if (!round) { res.status(404).json({ message: "Round not found" }); return null; }
  return { ...owned, round };
}

// Shape a round for the client, plus its money task when one exists.
function shapeRound(r, taskByRound) {
  const task = taskByRound ? taskByRound.get(String(r._id)) : null;
  return {
    _id: r._id,
    roundNumber: r.roundNumber,
    amount: r.amount,
    terms: r.terms || "",
    reasoning: r.reasoning || "",
    sentAt: r.sentAt || null,
    sentVia: r.sentVia || "",
    clientResponse: r.clientResponse || "",
    outcome: r.outcome || "pending",
    counterAmount: r.counterAmount,
    quoteRef: r.quoteRef || null,
    termsSentAt: r.termsSentAt || null,
    termsSentTo: r.termsSentTo || "",
    // Whether the terms email actually left, so the thread never reads "sent"
    // over a send that was recorded but not delivered.
    termsDelivered: Boolean(r.termsDelivered),
    termsDeliveryError: r.termsDeliveryError || "",
    createdAt: r.createdAt,
    task: task
      ? { _id: task._id, title: task.title, dueAt: task.dueAt, status: task.status }
      : null,
  };
}

// GET /venues/:slug/enquiries/:enquiryId/quote-rounds
const listRounds = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const rounds = await VenueQuoteRound.find({ enquiry: owned.lead._id })
      .sort({ createdAt: -1 })
      .lean();

    // The money tasks these rounds spawned — ONE task system, so they are read
    // from VenueTask rather than duplicated onto the round.
    const tasks = await VenueTask.find({
      venue: owned.venue._id,
      source: "money",
      sourceRef: { $in: rounds.map((r) => r._id) },
    })
      .select("_id title dueAt status sourceRef")
      .lean();
    const taskByRound = new Map(tasks.map((t) => [String(t.sourceRef), t]));

    return res.status(200).json({
      rounds: rounds.map((r) => shapeRound(r, taskByRound)),
      total: rounds.length,
      // The figure every other surface reads, echoed so the tab never has to
      // decide for itself what the current quote is.
      quotedValue: owned.lead.estimatedValue || 0,
      budget: owned.lead.budget || "",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/enquiries/:enquiryId/quote-rounds
// { amount?, terms?, reasoning?, sentAt?, sentVia?, clientResponse?, outcome?,
//   counterAmount?, quoteRef?, task?: { title, dueAt } }
const createRound = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { venue, lead } = owned;
    const body = req.body || {};

    // THE VALIDATION RULE. An amount is optional — "they rang and asked for a
    // discount before we re-quoted" is a real round. A client response is
    // optional — most rounds are logged when sent, before any reply. But a row
    // with NEITHER records that nothing happened, which is not a thing worth
    // storing and would render as an empty line in the thread.
    const amountSent = body.amount !== undefined && body.amount !== null && body.amount !== "";
    const responseSent = cleanStr(body.clientResponse).length > 0;
    if (!amountSent && !responseSent) {
      return res.status(400).json({
        message: "A round needs an amount or what they said — one of the two.",
      });
    }

    const amountV = amountSent ? optNumber(body.amount, "amount") : { ok: true, value: null };
    if (!amountV.ok) return res.status(400).json({ message: amountV.message });
    const counterV = body.counterAmount !== undefined && body.counterAmount !== null && body.counterAmount !== ""
      ? optNumber(body.counterAmount, "counterAmount")
      : { ok: true, value: null };
    if (!counterV.ok) return res.status(400).json({ message: counterV.message });

    for (const [v, f, max] of [[body.terms, "terms", MAXLEN.generic], [body.reasoning, "reasoning", MAXLEN.text], [body.clientResponse, "clientResponse", MAXLEN.text]]) {
      if (v !== undefined) { const r = optStr(v, f, max); if (!r.ok) return res.status(400).json({ message: r.message }); }
    }
    const sentAtV = optDate(body.sentAt, "sentAt");
    if (!sentAtV.ok) return res.status(400).json({ message: sentAtV.message });
    if (body.sentVia !== undefined && !SENT_VIA.includes(body.sentVia)) {
      return res.status(400).json({ message: `sentVia must be one of ${SENT_VIA.filter(Boolean).join(", ")}` });
    }
    if (body.outcome !== undefined && !OUTCOMES.includes(body.outcome)) {
      return res.status(400).json({ message: `outcome must be one of ${OUTCOMES.join(", ")}` });
    }

    const existing = await VenueQuoteRound.countDocuments({ enquiry: lead._id });
    if (existing >= MAX_ROUNDS) {
      return res.status(400).json({ message: `This lead already has ${MAX_ROUNDS} rounds.` });
    }

    // An optional link to a document from the EXISTING quote engine. Verified
    // to belong to this lead so a round cannot point at another lead's quote.
    let quoteRef;
    if (body.quoteRef) {
      if (!mongoose.isValidObjectId(body.quoteRef)) {
        return res.status(400).json({ message: "quoteRef is not a valid quote id" });
      }
      const q = await VenueQuote.findOne({ _id: body.quoteRef, enquiry: lead._id }).select("_id").lean();
      if (!q) return res.status(400).json({ message: "That quote does not belong to this lead" });
      quoteRef = q._id;
    }

    const round = await VenueQuoteRound.create({
      venue: venue._id,
      enquiry: lead._id,
      roundNumber: existing + 1,
      amount: amountV.value,
      terms: cleanStr(body.terms).slice(0, MAXLEN.generic),
      reasoning: cleanStr(body.reasoning).slice(0, MAXLEN.text),
      // Logging a round you have already sent is the common case, so sentAt
      // defaults to now rather than staying empty and reading as "not sent".
      sentAt: sentAtV.value || new Date(),
      sentVia: body.sentVia || "",
      clientResponse: cleanStr(body.clientResponse).slice(0, MAXLEN.text),
      outcome: body.outcome || (responseSent ? "countered" : "pending"),
      counterAmount: counterV.value,
      quoteRef,
      createdBy: actorIdOf(req),
    });

    // S2 — the optional follow-up, as a REAL task in the one task system.
    let task = null;
    if (body.task && cleanStr(body.task.title)) {
      task = await createMoneyTask(req, { venue, lead, round, input: body.task });
    }

    // Write the thread's figure through to the one place everything reads.
    const sync = await syncQuotedValue(lead);
    if (sync.changed) {
      lead.activities.push({
        type: "quote_changed",
        description: `Quote updated to ₹${sync.to.toLocaleString("en-IN")} (round ${round.roundNumber})`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
      await lead.save();
    }

    const shaped = shapeRound(round.toObject(), task ? new Map([[String(round._id), task]]) : null);
    return res.status(201).json({ round: shaped, quotedValue: lead.estimatedValue || 0 });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * S2 — a money-tagged task. Deliberately a plain VenueTask: it shows up in the
 * main Tasks list like everything else, labelled by where it came from, rather
 * than in a parallel to-do list nobody would remember to check.
 */
async function createMoneyTask(req, { venue, lead, round, input }) {
  const title = cleanStr(input.title).slice(0, MAXLEN.label);
  const dueV = optDate(input.dueAt, "task.dueAt");
  return VenueTask.create({
    venue: venue._id,
    title,
    notes: cleanStr(input.notes).slice(0, MAXLEN.text),
    dueAt: dueV.ok ? dueV.value : undefined,
    linkedEnquiry: lead._id,
    // Default the owner to whoever logged the round — the person who just said
    // "I'll get back to them on Tuesday" is the person who meant to do it.
    assignedTo: input.assignedTo || (await resolveActorMemberId(req)) || undefined,
    createdBy: actorIdOf(req),
    source: "money",
    sourceRef: round._id,
  });
}

// PATCH /venues/:slug/enquiries/:enquiryId/quote-rounds/:roundId
// Logging what they said, and what it means, after the fact.
const updateRound = async (req, res) => {
  try {
    const owned = await resolveOwnedRound(req, res);
    if (!owned) return;
    const { lead, round } = owned;
    const body = req.body || {};

    if (body.outcome !== undefined) {
      if (!OUTCOMES.includes(body.outcome)) {
        return res.status(400).json({ message: `outcome must be one of ${OUTCOMES.join(", ")}` });
      }
      round.outcome = body.outcome;
    }
    if (body.clientResponse !== undefined) {
      const r = optStr(body.clientResponse, "clientResponse", MAXLEN.text);
      if (!r.ok) return res.status(400).json({ message: r.message });
      round.clientResponse = r.value;
    }
    if (body.terms !== undefined) {
      const r = optStr(body.terms, "terms", MAXLEN.generic);
      if (!r.ok) return res.status(400).json({ message: r.message });
      round.terms = r.value;
    }
    if (body.reasoning !== undefined) {
      const r = optStr(body.reasoning, "reasoning", MAXLEN.text);
      if (!r.ok) return res.status(400).json({ message: r.message });
      round.reasoning = r.value;
    }
    if (body.counterAmount !== undefined) {
      if (body.counterAmount === null || body.counterAmount === "") round.counterAmount = null;
      else {
        const c = optNumber(body.counterAmount, "counterAmount");
        if (!c.ok) return res.status(400).json({ message: c.message });
        round.counterAmount = c.value;
      }
    }
    if (body.amount !== undefined) {
      if (body.amount === null || body.amount === "") {
        // Clearing the amount must not leave a round that says nothing.
        if (!cleanStr(round.clientResponse)) {
          return res.status(400).json({ message: "A round needs an amount or what they said — one of the two." });
        }
        round.amount = null;
      } else {
        const a = optNumber(body.amount, "amount");
        if (!a.ok) return res.status(400).json({ message: a.message });
        round.amount = a.value;
      }
    }
    if (body.sentVia !== undefined) {
      if (!SENT_VIA.includes(body.sentVia)) {
        return res.status(400).json({ message: `sentVia must be one of ${SENT_VIA.filter(Boolean).join(", ")}` });
      }
      round.sentVia = body.sentVia;
    }

    await round.save();
    const sync = await syncQuotedValue(lead);

    let task = null;
    if (body.task && cleanStr(body.task.title)) {
      task = await createMoneyTask(req, { venue: { _id: round.venue }, lead, round, input: body.task });
    } else {
      task = await VenueTask.findOne({ source: "money", sourceRef: round._id }).select("_id title dueAt status").lean();
    }

    return res.status(200).json({
      round: shapeRound(round.toObject(), task ? new Map([[String(round._id), task]]) : null),
      quotedValue: lead.estimatedValue || 0,
      quotedValueChanged: sync.changed,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/enquiries/:enquiryId/quote-rounds/:roundId
const deleteRound = async (req, res) => {
  try {
    const owned = await resolveOwnedRound(req, res);
    if (!owned) return;
    const { lead, round } = owned;
    await VenueQuoteRound.deleteOne({ _id: round._id });
    // The task it spawned is a real task with its own life — deleting the round
    // must not silently delete work somebody may already be doing. It is
    // unlinked instead, so it stays in the Tasks list and stops claiming an
    // origin that no longer exists.
    await VenueTask.updateMany(
      { source: "money", sourceRef: round._id },
      { $set: { source: "manual" }, $unset: { sourceRef: 1 } }
    );
    // roundNumber is NOT recomputed: renumbering would rewrite what the
    // remaining rounds were called in conversations that already happened.
    const sync = await syncQuotedValue(lead);
    return res.status(200).json({ success: true, quotedValue: lead.estimatedValue || 0, quotedValueChanged: sync.changed });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listRounds,
  createRound,
  updateRound,
  deleteRound,
  SENT_VIA,
  OUTCOMES,
};

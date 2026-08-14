// BUILD B — money as a negotiation log.
// Run: node tests/venue-money.test.js
//
// The load-bearing claims, each asserted rather than argued:
//   · ONE source of truth for the current quote. Rounds write THROUGH to
//     estimatedValue; every existing consumer keeps reading the same field.
//   · ONE task system. A money round's follow-up is a real VenueTask that
//     appears in the normal Tasks list, labelled by origin.
//   · Pricing intelligence is SCOPED like contention: aggregate venue-wide,
//     names and per-lead figures never outside the requester's scope — and the
//     raw amounts array is never returned at all.
//   · Deny sweep on every new read surface, with write-didn't-happen asserted.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueTask = require("../models/VenueTask");
const VenueBooking = require("../models/VenueBooking");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const AuspiciousDate = require("../models/AuspiciousDate");
const VenueDocumentTemplate = require("../models/VenueDocumentTemplate");

const rounds = require("../controllers/venueQuoteRound");
const pricing = require("../controllers/venuePricing");
const termsCtl = require("../controllers/venueTerms");
const tasksCtl = require("../controllers/venueTask");
const intel = require("../utils/venuePricingIntel");
const { latestQuotedAmount } = require("../utils/venueQuotedValue");

const TAG = `money-${Date.now()}`;
const YEAR = 2095;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() }, venueMember: null });
const memberReq = (venue, m, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: m._id, role: m.role }, venueMember: m });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };
const d = (mmdd) => `${YEAR}-${mmdd}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await AuspiciousDate.deleteMany({ year: YEAR });

    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    // 21 Nov is a Saturday in 2095 and auspicious — the comparables signature.
    await AuspiciousDate.create({ date: new Date(`${d("11-19")}T00:00:00Z`), year: YEAR, month: 11, day: 19, traditions: [], tier: "major", verified: true });

    const mkLead = (name, extra = {}) => VenueEnquiry.create({
      venueId: venue._id, coupleName: name, coupleNameManual: true, couplePhone: `9${Math.floor(Math.random() * 1e9)}`,
      stage: "contacted", budget: "₹7–8L", ...extra,
    });
    const lead = await mkLead(`${TAG} Hero`, { checkIn: new Date(`${d("11-19")}T06:00:00Z`) });
    const leadId = String(lead._id);
    const P = { enquiryId: leadId };

    // ── round validation ────────────────────────────────────────────────────
    console.log("\n[round validation]");
    const empty = await call(rounds.createRound, ownerReq(venue, { params: P, body: {} }));
    ok(empty.code === 400, "a round with NEITHER amount nor response → 400");
    ok(/amount or what they said/i.test(empty.body.message), "…and the message says which two things it wants");

    const responseOnly = await call(rounds.createRound, ownerReq(venue, { params: P, body: { clientResponse: "Can you do better on price?" } }));
    ok(responseOnly.code === 201, "THE RULE: a round with only a client response is VALID");
    ok(responseOnly.body.round.amount === null, "…and carries no amount");
    ok(responseOnly.body.round.outcome === "countered", "…outcome defaults to countered when they said something");

    const amountOnly = await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: 800000, terms: "+ GST", sentVia: "whatsapp" } }));
    ok(amountOnly.code === 201, "a round with only an amount is valid");
    ok(amountOnly.body.round.terms === "+ GST", "…terms stored verbatim, never parsed");
    ok(amountOnly.body.round.outcome === "pending", "…outcome defaults to pending when nothing came back");
    ok(Boolean(amountOnly.body.round.sentAt), "…sentAt defaults to now rather than reading as 'not sent'");
    ok((await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: -5 } }))).code === 400, "a negative amount → 400");
    ok((await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: 1, sentVia: "carrier_pigeon" } }))).code === 400, "an unknown sentVia → 400");
    ok((await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: 1, outcome: "maybe" } }))).code === 400, "an unknown outcome → 400");

    // ── the write-through ───────────────────────────────────────────────────
    console.log("\n[one source of truth for the quoted value]");
    let fresh = await VenueEnquiry.findById(leadId).lean();
    ok(fresh.estimatedValue === 800000, "the latest round with an amount writes THROUGH to estimatedValue");
    ok(await latestQuotedAmount(lead._id) === 800000, "…and the helper agrees");

    const r2 = await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: 750000, terms: "+ GST + ₹50k refundable deposit" } }));
    fresh = await VenueEnquiry.findById(leadId).lean();
    ok(fresh.estimatedValue === 750000, "a newer round supersedes it");
    ok(fresh.activities.some((a) => a.type === "quote_changed"), "…and the change lands on the lead timeline");

    // A no-amount round must NOT zero the figure.
    await call(rounds.createRound, ownerReq(venue, { params: P, body: { clientResponse: "Still too high" } }));
    fresh = await VenueEnquiry.findById(leadId).lean();
    ok(fresh.estimatedValue === 750000, "THE GUARD: a response-only round does not blank the quoted value");

    // Every consumer reads the same field — proven at the database level.
    const projected = await VenueEnquiry.find({ _id: lead._id }).select("estimatedValue").lean();
    ok(projected[0].estimatedValue === 750000, "…projectable via .select(), which is how the OS reads it");
    const summed = await VenueEnquiry.aggregate([{ $match: { venueId: venue._id } }, { $group: { _id: null, total: { $sum: "$estimatedValue" } } }]);
    ok(summed[0].total >= 750000, "…and summable in an aggregation, which is how pipeline totals read it");

    // A booked lead's number belongs to its booking, not to a stray round.
    const bookedLead = await mkLead(`${TAG} Booked`, { checkIn: new Date(`${d("11-19")}T06:00:00Z`), stage: "booked", estimatedValue: 999999 });
    await call(rounds.createRound, ownerReq(venue, { params: { enquiryId: String(bookedLead._id) }, body: { amount: 1 } }));
    const bookedFresh = await VenueEnquiry.findById(bookedLead._id).lean();
    ok(bookedFresh.estimatedValue === 999999, "PRECEDENCE: a booked lead's value is NOT overwritten by a later round");

    // ── update + delete ─────────────────────────────────────────────────────
    console.log("\n[logging their response later]");
    const roundId = String(r2.body.round._id);
    const upd = await call(rounds.updateRound, ownerReq(venue, { params: { ...P, roundId }, body: { clientResponse: "Can you do 6.8?", outcome: "countered", counterAmount: 680000 } }));
    ok(upd.code === 200, "PATCH logs the response → 200");
    ok(upd.body.round.clientResponse === "Can you do 6.8?", "…in their words");
    ok(upd.body.round.counterAmount === 680000, "…with their counter");
    ok((await call(rounds.updateRound, ownerReq(venue, { params: { ...P, roundId }, body: { amount: null } }))).code === 200, "clearing an amount is fine when a response exists");
    const noBoth = await call(rounds.createRound, ownerReq(venue, { params: P, body: { amount: 700000 } }));
    const noBothId = String(noBoth.body.round._id);
    ok((await call(rounds.updateRound, ownerReq(venue, { params: { ...P, roundId: noBothId }, body: { amount: null } }))).code === 400, "…but not when it would leave the round saying nothing");

    // ── money-tagged tasks: ONE system ──────────────────────────────────────
    console.log("\n[money tasks live in the ONE task system]");
    const withTask = await call(rounds.createRound, ownerReq(venue, {
      params: P,
      body: { amount: 720000, terms: "+ GST, incl. 200 plates", task: { title: "Revised quote back to them", dueAt: d("11-10") } },
    }));
    ok(withTask.code === 201 && withTask.body.round.task, "a round can spawn a follow-up");
    ok(withTask.body.round.task.title === "Revised quote back to them", "…with the title given");

    const taskRow = await VenueTask.findOne({ source: "money" }).lean();
    ok(Boolean(taskRow), "THE ONE SYSTEM: it is a real VenueTask");
    ok(String(taskRow.linkedEnquiry) === leadId, "…linked to the lead");
    ok(String(taskRow.sourceRef) === String(withTask.body.round._id), "…and back to the round it came from");

    const taskList = await call(tasksCtl.listTasks, ownerReq(venue, { query: { filter: "all" } }));
    const inMainList = taskList.body.tasks.find((t) => String(t._id) === String(taskRow._id));
    ok(Boolean(inMainList), "…and it appears in the MAIN tasks list, not a parallel one");
    ok(inMainList.source === "money", "…carrying its origin so the list can label it");
    ok(taskList.body.tasks.some((t) => t.source !== "money") || taskList.body.tasks.length === 1, "…alongside ordinary tasks");

    const threadWithTask = await call(rounds.listRounds, ownerReq(venue, { params: P }));
    ok(threadWithTask.body.rounds.some((r) => r.task && String(r.task._id) === String(taskRow._id)), "…and on the Money thread, from the SAME record");

    // Deleting a round must not delete work somebody may be doing.
    await call(rounds.deleteRound, ownerReq(venue, { params: { ...P, roundId: String(withTask.body.round._id) } }));
    const orphan = await VenueTask.findById(taskRow._id).lean();
    ok(Boolean(orphan), "deleting a round does NOT delete the task it spawned");
    ok(orphan.source === "manual" && !orphan.sourceRef, "…it is unlinked instead, so it stops claiming an origin that is gone");

    // ── the thread read ─────────────────────────────────────────────────────
    console.log("\n[the thread]");
    const thread = await call(rounds.listRounds, ownerReq(venue, { params: P }));
    ok(thread.code === 200, "thread read → 200");
    ok(thread.body.rounds.length >= 4, "…every round present");
    const dates = thread.body.rounds.map((r) => new Date(r.createdAt).getTime());
    ok(dates.every((v, i) => i === 0 || dates[i - 1] >= v), "…newest first");
    ok(thread.body.quotedValue === (await VenueEnquiry.findById(leadId).lean()).estimatedValue, "…echoing the ONE quoted value so the tab never decides for itself");
    ok(thread.body.budget === "₹7–8L", "…and their budget");

    // ── pricing intelligence ────────────────────────────────────────────────
    console.log("\n[pricing intelligence]");
    // Not enough comparables yet — must SAY so rather than invent a range.
    const thin = await call(pricing.getPricingIntel, ownerReq(venue, { params: P }));
    ok(thin.code === 200 && thin.body.enabled === true, "pricing read → 200, enabled");
    ok(/not enough|No comparable/i.test(thin.body.advice), "HONESTY: with no comparables it says so rather than inventing a range");
    ok(thin.body.signals.comparables.enough === false, "…and the signal says enough=false");
    ok(thin.body.signals.minComparables === intel.MIN_COMPARABLES, "…and states the threshold it used");

    // Give it real comparables: bookings on matching-shape dates.
    for (const [i, amt] of [700000, 780000, 820000, 760000].entries()) {
      const bl = await mkLead(`${TAG} Past ${i}`, { checkIn: new Date(`${d("11-19")}T06:00:00Z`), stage: "booked" });
      await VenueBooking.create({
        venue: venue._id, enquiry: bl._id, totalValue: amt, status: "confirmed",
        days: [{ date: new Date(`${d("11-19")}T00:00:00Z`), eventType: "wedding", guestCount: 300 }],
      });
    }
    const rich = await call(pricing.getPricingIntel, ownerReq(venue, { params: P }));
    ok(rich.body.signals.comparables.count === 4, `4 comparables found (got ${rich.body.signals.comparables.count})`);
    ok(rich.body.signals.comparables.enough === true, "…enough to speak");
    ok(/comparable/i.test(rich.body.advice) && /₹/.test(rich.body.advice), "the advice now NAMES a range");
    ok(rich.body.signals.comparables.median > 0, "…with a median");
    ok(rich.body.signals.comparables.matchedOn && typeof rich.body.signals.comparables.matchedOn.auspicious === "boolean", "…and says what made them comparable");

    // The banned-phrase sweep — same rule as the calendar note.
    const BANNED = [/prefer\s+the/i, /better\s+customer/i, /bigger\s+budget/i, /north\s+indian/i, /south\s+indian/i, /rich(er)?\b/i, /these\s+people/i];
    const advices = [thin.body.advice, rich.body.advice].filter(Boolean);
    let banned = 0;
    for (const a of advices) for (const re of BANNED) if (re.test(a)) { banned++; console.error(`  ✗ BANNED ${re} in: ${a}`); }
    ok(banned === 0, `no banned phrasing across ${advices.length} composed advice lines`);

    // ── scoping of the competing table ──────────────────────────────────────
    console.log("\n[pricing intelligence is SCOPED like contention]");
    const salesBundle = await VenueRole.create({ venue: venue._id, name: `${TAG}-sales`, capabilities: ["leads", "bookings_money"] });
    const scoped = await VenueTeamMember.create({ venueId: venue._id, name: `${TAG}-scoped`, phone: `${TAG}s`, role: "sales", roleRef: salesBundle._id, isActive: true });
    const rival = await mkLead(`${TAG} Rival`, { checkIn: new Date(`${d("11-19")}T06:00:00Z`), estimatedValue: 900000 });
    const ownLead = await mkLead(`${TAG} Mine`, { checkIn: new Date(`${d("11-19")}T06:00:00Z`), estimatedValue: 640000, assignedTo: scoped._id });

    const ownerView = await call(pricing.getPricingIntel, ownerReq(venue, { params: P }));
    ok(ownerView.body.signals.competing.count >= 2, "the owner sees the competing count");
    ok(ownerView.body.signals.competing.named.some((n) => n.name.includes("Rival")), "…and can see the names");

    const scopedView = await call(pricing.getPricingIntel, memberReq(venue, scoped, { params: { enquiryId: String(ownLead._id) } }));
    ok(scopedView.code === 200, "a scoped member gets the pricing read for their OWN lead");
    ok(scopedView.body.signals.competing.count >= 2, "…with the true venue-wide count (the aggregate is the value)");
    ok(!scopedView.body.signals.competing.named.some((n) => n.name.includes("Rival")), "…but NOT the rival's name");
    ok(scopedView.body.signals.competing.hiddenCount >= 1, "…the invisible ones counted, never named");
    ok(scopedView.body.signals.competing.scoped === true, "…and flagged as scoped so the UI can say so");
    ok(scopedView.body.signals.competing.amounts === undefined, "THE LEAK GUARD: the raw per-lead amounts array is never returned");
    ok(typeof scopedView.body.signals.competing.median === "number", "…only aggregates cross the boundary");
    ok(!JSON.stringify(scopedView.body).includes(`${TAG} Rival`), "…and the rival appears NOWHERE in the payload");

    // ── dismissal + venue switch ────────────────────────────────────────────
    console.log("\n[dismissal]");
    const dis = await call(pricing.dismissPricingAdvice, ownerReq(venue, { params: P, body: {} }));
    ok(dis.code === 200 && dis.body.dismissed === true, "dismiss → 200");
    const afterDis = await call(pricing.getPricingIntel, ownerReq(venue, { params: P }));
    ok(afterDis.body.dismissed === true, "…persisted per lead");
    ok(afterDis.body.advice.length > 0, "…but still computed, so re-opening needs no round trip");
    const otherLeadIntel = await call(pricing.getPricingIntel, ownerReq(venue, { params: { enquiryId: String(rival._id) } }));
    ok(otherLeadIntel.body.dismissed === false, "…and dismissal is PER LEAD, not global");
    await call(pricing.dismissPricingAdvice, ownerReq(venue, { params: P, body: { dismissed: false } }));
    ok((await call(pricing.getPricingIntel, ownerReq(venue, { params: P }))).body.dismissed === false, "…and reversible");

    await Venue.updateOne({ _id: venue._id }, { $set: { "settings.pricingAdvice": false } });
    const off = await call(pricing.getPricingIntel, ownerReq(venue, { params: P }));
    ok(off.body.enabled === false && off.body.reason === "venue_setting", "the venue-wide switch turns it off entirely");
    ok(off.body.advice === "" && off.body.signals === null, "…and short-circuits the computation");
    await Venue.updateOne({ _id: venue._id }, { $set: { "settings.pricingAdvice": true } });

    // ── terms ───────────────────────────────────────────────────────────────
    console.log("\n[terms & conditions]");
    const noTerms = await call(termsCtl.previewTerms, ownerReq(venue, { params: P }));
    ok(noTerms.code === 200 && noTerms.body.ready === false, "a venue with no policies written says so rather than offering an empty PDF");
    ok((await call(termsCtl.sendTerms, ownerReq(venue, { params: P, body: { email: "x@y.com" } }))).code === 400, "…and refuses to send nothing");

    await Venue.updateOne({ _id: venue._id }, { $set: { policyDoc: { policies: ["No open flames."], terms: ["50% advance."], refund: ["No refund inside 30 days."] } } });
    const preview = await call(termsCtl.previewTerms, ownerReq(venue, { params: P }));
    ok(preview.body.ready === true && preview.body.clauseCount === 3, "policyDoc seeds the clauses (REUSED from the contract flow)");
    ok(preview.body.source === "policy_doc", "…and says where they came from");

    await VenueDocumentTemplate.create({ venue: venue._id, type: "contract", name: `${TAG}-tpl`, sections: [{ heading: "House Rules", clauses: ["Music off by 11pm.", "No outside alcohol."] }], terms: ["Payment in 3 milestones."] });
    const tplPreview = await call(termsCtl.previewTerms, ownerReq(venue, { params: P }));
    ok(tplPreview.body.source === "template", "an authored template WINS over the policyDoc fallback");
    ok(tplPreview.body.clauseCount === 3, "…and carries its clauses plus its terms block");

    await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { contacts: [{ name: "Priya", phone: "9800000001", email: "priya@example.com", relation: "bride", role: "bride", isPrimary: true, isDecisionMaker: false }] } });
    const recips = await call(termsCtl.previewTerms, ownerReq(venue, { params: P }));
    ok(recips.body.recipients.length === 1 && recips.body.recipients[0].email === "priya@example.com", "recipients come from CONTACTS' emails");

    ok((await call(termsCtl.sendTerms, ownerReq(venue, { params: P, body: { email: "not-an-email" } }))).code === 400, "a malformed recipient → 400");
    const sent = await call(termsCtl.sendTerms, ownerReq(venue, { params: P, body: { email: "priya@example.com" } }));
    ok(sent.code === 200 && sent.body.success, "send → 200");
    ok(sent.body.delivered === false && /template is configured|transport/i.test(sent.body.deliveryError), "HONEST: with no mail template it reports recorded-but-not-emailed rather than claiming delivery");
    const sentRound = await VenueQuoteRound.findById(sent.body.roundId).lean();
    ok(Boolean(sentRound.termsSentAt) && sentRound.termsSentTo === "priya@example.com", "the send is recorded ON a round — the thread shows they were informed");
    ok((sentRound.termsSnapshot || []).length > 0, "…with the clause text FROZEN at send time");
    const leadAfterTerms = await VenueEnquiry.findById(leadId).lean();
    ok(leadAfterTerms.activities.some((a) => a.type === "terms_sent"), "…and on the lead timeline");

    // Editing the template afterwards must not rewrite what they were sent.
    await VenueDocumentTemplate.updateOne({ venue: venue._id, type: "contract" }, { $set: { sections: [{ heading: "Changed", clauses: ["Totally different."] }] } });
    const stillFrozen = await VenueQuoteRound.findById(sent.body.roundId).lean();
    ok(stillFrozen.termsSnapshot[0].heading === "House Rules", "THE FREEZE: editing the template does not rewrite what was already sent");

    // ── deny sweep ──────────────────────────────────────────────────────────
    console.log("\n[deny sweep: scoped member vs another member's lead]");
    const before = await VenueEnquiry.findById(leadId).lean();
    const beforeRounds = await VenueQuoteRound.countDocuments({ enquiry: lead._id });

    ok((await call(rounds.listRounds, memberReq(venue, scoped, { params: P }))).code === 404, "thread read by direct id → 404, never 403");
    const denyCreate = await call(rounds.createRound, memberReq(venue, scoped, { params: P, body: { amount: 1 } }));
    ok(denyCreate.code === 404, "creating a round on their lead → 404");
    ok((await VenueQuoteRound.countDocuments({ enquiry: lead._id })) === beforeRounds, "THE WRITE DID NOT HAPPEN: no round was created");

    const denyPatch = await call(rounds.updateRound, memberReq(venue, scoped, { params: { ...P, roundId }, body: { clientResponse: "HACKED" } }));
    ok(denyPatch.code === 404, "patching their round → 404");
    ok(!(await VenueQuoteRound.findById(roundId).lean()).clientResponse.includes("HACKED"), "…and the round is unchanged");

    ok((await call(rounds.deleteRound, memberReq(venue, scoped, { params: { ...P, roundId } }))).code === 404, "deleting their round → 404");
    ok((await VenueQuoteRound.countDocuments({ enquiry: lead._id })) === beforeRounds, "…and nothing was deleted");

    ok((await call(pricing.getPricingIntel, memberReq(venue, scoped, { params: P }))).code === 404, "pricing read on their lead → 404");
    const denyDismiss = await call(pricing.dismissPricingAdvice, memberReq(venue, scoped, { params: P, body: {} }));
    ok(denyDismiss.code === 404, "dismissing on their lead → 404");
    ok((await VenueEnquiry.findById(leadId).lean()).pricingAdviceDismissed === before.pricingAdviceDismissed, "…and the flag is untouched");

    ok((await call(termsCtl.previewTerms, memberReq(venue, scoped, { params: P }))).code === 404, "terms preview on their lead → 404");
    const denySend = await call(termsCtl.sendTerms, memberReq(venue, scoped, { params: P, body: { email: "evil@example.com" } }));
    ok(denySend.code === 404, "terms send on their lead → 404");
    ok(!(await VenueEnquiry.findById(leadId).lean()).activities.some((a) => /evil@/.test(a.description || "")), "…and nothing was sent or logged");

    // Soft-deleted leads stay unreachable everywhere.
    await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { deleted: true, deletedAt: new Date() } });
    ok((await call(rounds.listRounds, ownerReq(venue, { params: P }))).code === 404, "a soft-deleted lead's thread → 404 even for the owner");
    ok((await call(pricing.getPricingIntel, ownerReq(venue, { params: P }))).code === 404, "…and its pricing read");
    ok((await call(termsCtl.previewTerms, ownerReq(venue, { params: P }))).code === 404, "…and its terms preview");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueQuoteRound.deleteMany({ venue: v });
      await VenueTask.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueDocumentTemplate.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
      void leads;
    }
    await AuspiciousDate.deleteMany({ year: YEAR }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

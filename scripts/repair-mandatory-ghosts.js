// T1 — REPORT-THEN-REPAIR for legacy mandatory "ghost" rows.
//
// The ghost: pre-batch-3 mandatory rows (no questionId, verbose legacy titles
// like "Generator (6Hrs) - Format - …", stored itemRequired + TS + priced).
// The batch-4 dedupe cleaned the QUESTION collection but never the ROWS baked
// onto event days. Once someone re-answers via the configured flow, a fresh
// questionId-bearing row lands NEXT TO the legacy sibling → the concept is
// billed twice, silently.
//
// This script:
//   census (default, READ-ONLY): per concept, how many days carry a
//     configured keeper + a legacy sibling (a repairable ghost), the total
//     rupee impact, plus the surrounding buckets (legacy-only days that are
//     NOT auto-repairable, locked drafts, couple-origin events).
//   repair (--apply): for each repairable day, KEEP the configured keeper(s)
//     and DROP (or --zero) the legacy sibling(s). Never touches a concept
//     group that has no keeper, never touches a single-row group, never edits
//     a keeper, never changes an answer. Fire-safe (per-event try/catch) and
//     idempotent (a second run finds nothing).
//
// Scope: OS drafts (leadId set) by default. Couple-origin events (real bills)
// are reported but only repaired with --include-couple. Locked drafts are
// reported and skipped unless --include-locked.
//
// Usage:
//   node scripts/repair-mandatory-ghosts.js                 # census (read-only)
//   node scripts/repair-mandatory-ghosts.js --apply         # repair (drop)
//   node scripts/repair-mandatory-ghosts.js --apply --zero  # repair (neutralize in place)
//   [--include-couple] [--include-locked]
require("dotenv").config();
const mongoose = require("mongoose");
const Event = require("../models/Event");
const Enquiry = require("../models/Enquiry");
const EventMandatoryQuestion = require("../models/EventMandatoryQuestion");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const ZERO = args.has("--zero"); // neutralize in place instead of removing the row
const INCLUDE_COUPLE = args.has("--include-couple");
const INCLUDE_LOCKED = args.has("--include-locked");

// Canonical concepts. `match` catches every legacy title variant; the keeper
// for a concept is any row whose questionId resolves to a CONFIGURED question
// (config.type set) whose title also matches. Add a line here for a new concept.
const CONCEPTS = [
  { key: "transport", label: "Transportation", match: /transport/i },
  { key: "generator", label: "Generator", match: /generat/i },
];

const rupee = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
// A mandatory row's live contribution to the grand total (Bug 79 law):
// not-required → prices nowhere; ES → day total; TS → event level. Either way
// this is the amount that leaves the grand total when the row is dropped.
const billImpact = (mi) => (mi && mi.itemRequired ? Math.round(Number(mi.price) || 0) : 0);
const conceptOf = (title) => CONCEPTS.find((c) => c.match.test(String(title || "")));

// PURE — classify one day's rows for one concept. Exported for the test suite.
// Returns { keepers, legacy } when the group is a repairable ghost (≥1 keeper
// AND ≥1 legacy sibling), { ambiguous } for a keeper-less multi-legacy group,
// or null for a single-row / non-ghost group.
const classifyDayConcept = (rows, concept, keeperIds) => {
  const group = (rows || []).filter((mi) => concept.match.test(mi.title || ""));
  if (group.length < 2) return null;
  const keepers = group.filter((mi) => mi.questionId && keeperIds.has(String(mi.questionId)));
  const legacy = group.filter((mi) => !keepers.includes(mi));
  if (keepers.length >= 1 && legacy.length >= 1) return { keepers, legacy };
  if (keepers.length === 0) return { ambiguous: group };
  return null; // keeper-only (incl. a double-answer) — never touched here
};

// Exported for the test suite (detection is pure; DB scan/repair is not).
module.exports = { classifyDayConcept, billImpact, CONCEPTS };

if (require.main !== module) return; // required as a module → skip the DB run

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 15000 });

  // configured question ids per concept (the keeper anchors)
  const configured = await EventMandatoryQuestion.find(
    { "config.type": { $in: ["note", "options"] } },
    { title: 1, "config.type": 1 }
  ).lean();
  const keeperIdsByConcept = new Map(CONCEPTS.map((c) => [c.key, new Set()]));
  for (const q of configured) {
    const c = conceptOf(q.title);
    if (c) keeperIdsByConcept.get(c.key).add(String(q._id));
  }
  for (const c of CONCEPTS) {
    if (!keeperIdsByConcept.get(c.key).size) {
      console.log(`⚠ no CONFIGURED question found for "${c.label}" — its ghosts can't be anchored (reported as legacy-only, never auto-repaired).`);
    }
  }

  const events = await Event.find(
    { "eventDays.mandatoryItems.0": { $exists: true } },
    { name: 1, draftName: 1, leadId: 1, locked: 1, eventDays: 1 }
  ).lean();

  // buckets
  const stats = {
    eventsScanned: events.length,
    osDrafts: 0,
    coupleEvents: 0,
    lockedEvents: 0,
    repairable: { days: 0, ghostRows: 0, rupee: 0, byConcept: {} },
    legacyOnly: { days: 0, rows: 0, rupee: 0, byConcept: {} }, // legacy rows, no keeper on the day → NOT auto-repairable
    outOfScopeCouple: { ghostRows: 0, rupee: 0 },
    outOfScopeLocked: { ghostRows: 0, rupee: 0 },
    doubleKeeper: { days: 0 }, // two configured rows same concept — a real double-answer, left alone
  };
  for (const c of CONCEPTS) {
    stats.repairable.byConcept[c.key] = { days: 0, rows: 0, rupee: 0 };
    stats.legacyOnly.byConcept[c.key] = { days: 0, rows: 0, rupee: 0 };
  }
  const detail = []; // per-repairable-day rows for the report table
  const legacyTitleFreq = {};
  const repairPlan = []; // { eventId, dayIdx, dropRowIds:[...] } for --apply

  const inRepairScope = (e) =>
    (e.leadId ? true : INCLUDE_COUPLE) && (!e.locked || INCLUDE_LOCKED);

  for (const e of events) {
    if (e.leadId) stats.osDrafts++; else stats.coupleEvents++;
    if (e.locked) stats.lockedEvents++;

    (e.eventDays || []).forEach((day, dayIdx) => {
      const rows = day.mandatoryItems || [];
      for (const c of CONCEPTS) {
        const verdict = classifyDayConcept(rows, c, keeperIdsByConcept.get(c.key));
        if (!verdict) continue;
        if (verdict.ambiguous) {
          // ≥2 legacy rows for one concept, no configured anchor → ambiguous.
          // Never guessed (would risk changing an answer); reported only.
          const group = verdict.ambiguous;
          const dayRupee = group.reduce((s, mi) => s + billImpact(mi), 0);
          const bc = stats.legacyOnly.byConcept[c.key];
          bc.days++; bc.rows += group.length; bc.rupee += dayRupee;
          stats.legacyOnly.days++; stats.legacyOnly.rows += group.length; stats.legacyOnly.rupee += dayRupee;
          continue;
        }
        {
          const { keepers, legacy } = verdict;
          // a repairable ghost: keep the keeper(s), drop the legacy sibling(s)
          if (keepers.length >= 2) stats.doubleKeeper.days++;
          for (const mi of legacy) legacyTitleFreq[(mi.title || "").slice(0, 55)] = (legacyTitleFreq[(mi.title || "").slice(0, 55)] || 0) + 1;
          const dayRupee = legacy.reduce((s, mi) => s + billImpact(mi), 0);
          const bc = stats.repairable.byConcept[c.key];
          bc.days++; bc.rows += legacy.length; bc.rupee += dayRupee;
          stats.repairable.days++; stats.repairable.ghostRows += legacy.length; stats.repairable.rupee += dayRupee;
          if (!inRepairScope(e)) {
            if (!e.leadId && !INCLUDE_COUPLE) { stats.outOfScopeCouple.ghostRows += legacy.length; stats.outOfScopeCouple.rupee += dayRupee; }
            if (e.locked && !INCLUDE_LOCKED) { stats.outOfScopeLocked.ghostRows += legacy.length; stats.outOfScopeLocked.rupee += dayRupee; }
          } else {
            repairPlan.push({ eventId: e._id, dayIdx, dropIds: legacy.map((mi) => String(mi._id)) });
          }
          if (detail.length < 40) {
            detail.push({
              event: (e.draftName || e.name || "").slice(0, 28),
              origin: e.leadId ? "os" : "couple",
              locked: !!e.locked,
              day: (day.name || `#${dayIdx}`).slice(0, 14),
              concept: c.label,
              keep: (keepers[0].title || "").slice(0, 30),
              drop: legacy.map((mi) => `${(mi.title || "").slice(0, 30)} [${rupee(billImpact(mi))}]`).join(" ; "),
              rupee: dayRupee,
            });
          }
        }
      }
    });
  }

  // ── REPORT ──
  const line = "─".repeat(66);
  console.log(`\n${line}\nMANDATORY GHOST CENSUS  (${APPLY ? "REPAIR RUN" : "READ-ONLY"})\n${line}`);
  console.log(`events with mandatory rows : ${stats.eventsScanned}`);
  console.log(`  · OS drafts (leadId set) : ${stats.osDrafts}`);
  console.log(`  · couple-origin events   : ${stats.coupleEvents}`);
  console.log(`  · locked                 : ${stats.lockedEvents}`);
  console.log(`\nREPAIRABLE GHOSTS (configured keeper + legacy sibling on the same day):`);
  console.log(`  days affected : ${stats.repairable.days}`);
  console.log(`  ghost rows    : ${stats.repairable.ghostRows}`);
  console.log(`  rupee impact  : ${rupee(stats.repairable.rupee)}  (billing legacy siblings that would leave the grand total)`);
  for (const c of CONCEPTS) {
    const b = stats.repairable.byConcept[c.key];
    console.log(`     ${c.label.padEnd(16)} days ${String(b.days).padStart(3)} · rows ${String(b.rows).padStart(3)} · ${rupee(b.rupee)}`);
  }
  if (stats.doubleKeeper.days) console.log(`  (${stats.doubleKeeper.days} day(s) also carry 2+ configured rows for one concept — a real double-answer, LEFT ALONE)`);

  console.log(`\nNOT AUTO-REPAIRABLE — legacy-only days (≥2 legacy rows, NO configured anchor):`);
  console.log(`  days ${stats.legacyOnly.days} · rows ${stats.legacyOnly.rows} · ${rupee(stats.legacyOnly.rupee)}  → need a re-answer or a manual call`);

  console.log(`\nOUT OF DEFAULT REPAIR SCOPE (still counted above):`);
  console.log(`  couple-origin ghosts : rows ${stats.outOfScopeCouple.ghostRows} · ${rupee(stats.outOfScopeCouple.rupee)}  (opt in with --include-couple)`);
  console.log(`  locked-draft ghosts  : rows ${stats.outOfScopeLocked.ghostRows} · ${rupee(stats.outOfScopeLocked.rupee)}  (opt in with --include-locked)`);

  if (Object.keys(legacyTitleFreq).length) {
    console.log(`\nlegacy sibling titles that WOULD be dropped (verify the matching):`);
    Object.entries(legacyTitleFreq).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .forEach(([t, n]) => console.log(`  ${String(n).padStart(3)}  ${JSON.stringify(t)}`));
  }
  if (detail.length) {
    console.log(`\nper-day detail (first ${detail.length}):`);
    for (const d of detail) {
      console.log(`  [${d.origin}${d.locked ? ",locked" : ""}] ${d.event} · ${d.day} · ${d.concept}`);
      console.log(`        keep: ${d.keep}`);
      console.log(`        drop: ${d.drop}`);
    }
  }

  const plannedRows = repairPlan.reduce((s, p) => s + p.dropIds.length, 0);
  console.log(`\nIN-SCOPE, READY TO REPAIR: ${plannedRows} ghost row(s) across ${repairPlan.length} day(s).`);

  // ── REPAIR (only with --apply) ──
  if (APPLY) {
    if (!plannedRows) {
      console.log("\nNothing in scope to repair — no writes performed (idempotent no-op).");
    } else {
      console.log(`\n${ZERO ? "ZEROING" : "DROPPING"} ${plannedRows} legacy sibling row(s) …`);
      let done = 0, failed = 0;
      for (const p of repairPlan) {
        try {
          if (ZERO) {
            // neutralize in place — kills the silent bill, keeps the row for audit
            await Event.updateOne(
              { _id: p.eventId },
              {
                $set: {
                  [`eventDays.${p.dayIdx}.mandatoryItems.$[m].price`]: 0,
                  [`eventDays.${p.dayIdx}.mandatoryItems.$[m].itemRequired`]: false,
                  [`eventDays.${p.dayIdx}.mandatoryItems.$[m].includeInTotalSummary`]: false,
                },
              },
              { arrayFilters: [{ "m._id": { $in: p.dropIds.map((id) => new mongoose.Types.ObjectId(id)) } }] }
            );
          } else {
            await Event.updateOne(
              { _id: p.eventId },
              { $pull: { [`eventDays.${p.dayIdx}.mandatoryItems`]: { _id: { $in: p.dropIds.map((id) => new mongoose.Types.ObjectId(id)) } } } }
            );
          }
          done += p.dropIds.length;
        } catch (e) {
          failed += p.dropIds.length;
          console.error(`  ✗ event ${p.eventId} day ${p.dayIdx}: ${e.message}`);
        }
      }
      console.log(`\n✓ repaired ${done} row(s)${failed ? `, ${failed} failed` : ""}. Totals recompute on next draft read (no stored-amount rewrite needed).`);
    }
  } else {
    console.log(`\nREAD-ONLY census — no writes. Re-run with --apply to repair (after go-ahead).`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("census/repair failed:", e);
  process.exit(1);
});

/* DecorDraft.draft.productCode — repair duplicate provisional codes.
 *
 * THE BUG (fixed at source 2026-08-21): the code generator read only the Decor
 * collection for the highest code in use and never looked at the approvals
 * queue, so every draft created before the first approval was handed the SAME
 * "next free" code. Five queued drafts were sitting on st236.
 *
 * The generator is now drafts-aware and approve auto-advances past a taken
 * provisional code, so drafts created from here on are fine and the existing
 * ones would resolve themselves one approval at a time. This script exists for
 * the VISIBLE half: until each is approved the queue shows the same code five
 * times, which is exactly the confusing state that surfaced the bug.
 *
 * WHAT IT TOUCHES
 *   · QUEUED drafts ONLY. An approved draft's code is already live on a product
 *     and rewriting it would divorce the draft from what it published. A
 *     rejected draft is never going to publish, so it is left alone too.
 *   · draft.productCode only — a plain $set. It is NOT in IMMUTABLE_PATHS
 *     (aiAnalysis, pricing.aiSuggested, pricing.panelQuote, sourceRead), so no
 *     hook fires and no "before" evidence is touched.
 *
 * HOW IT CHOOSES
 *   Re-derives against the catalogue AT RUN TIME — it does not assume st236 is
 *   still free. Drafts are processed in addedAt order and the OLDEST keeps the
 *   contested code; the rest take the next genuinely free ones. Each assignment
 *   is reserved in-process so two drafts in the same run cannot collide.
 *
 *   Note the replacements are not guaranteed to sit ABOVE the kept code: like
 *   the generator itself, this fills free gaps in the sequence. If st235 is
 *   unused it will be handed out even though the keeper holds st236. That is
 *   deliberate — a free code is a free code, and refusing to reuse gaps would
 *   slowly strand them forever.
 *
 * SAFETY
 *   · Dry run by default. --confirm is required to write.
 *   · Idempotent: a second run finds nothing to do and says so.
 *   · Aborts before writing anything if a draft looks unexpected — no category,
 *     no derivable prefix, or a code that does not parse.
 *
 * RUN IT ON THE EC2 BOX, against prod:
 *
 *   ssh <ec2>
 *   cd /path/to/wedsy-server-crm
 *   node scripts/repair-decor-draft-codes.js            # DRY RUN
 *   node scripts/repair-decor-draft-codes.js --confirm  # write
 *   node scripts/repair-decor-draft-codes.js            # verify (0 duplicates)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const line = (s = "") => console.log(s);

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("DATABASE_URL not set — refusing to run.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const DecorDraft = require("../models/DecorDraft");
  const { prefixForCategory, maxSuffixForPrefix, isCodeTaken, parseCode } = require("../utils/decorCode");

  line(`Target : ${mongoose.connection.host}/${mongoose.connection.name}`);
  line(`Mode   : ${CONFIRM ? "REPAIR (--confirm)" : "DRY RUN (read-only)"}`);
  line("");

  const queued = await DecorDraft.find(
    { status: "queued" },
    { "draft.productCode": 1, "draft.category": 1, "suggested.category": 1, addedAt: 1, "draft.name": 1 }
  )
    .sort({ addedAt: 1, _id: 1 })
    .lean();

  line(`queued drafts: ${queued.length}`);
  if (!queued.length) {
    line("Nothing to inspect.");
    await mongoose.disconnect();
    return;
  }

  // ── which codes are duplicated across the queue ───────────────────────────
  const byCode = new Map();
  for (const d of queued) {
    const code = String((d.draft && d.draft.productCode) || "").trim();
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(d);
  }
  const dupes = [...byCode.entries()].filter(([, list]) => list.length > 1);
  line(`distinct codes in the queue: ${byCode.size}`);
  line(`codes held by MORE THAN ONE queued draft: ${dupes.length}`);
  for (const [code, list] of dupes) {
    line(`  ${code}  ×${list.length}`);
    for (const d of list) {
      line(`      ${String(d._id)}  ${new Date(d.addedAt).toISOString().slice(0, 10)}  ${String((d.draft && d.draft.name) || "").slice(0, 40)}`);
    }
  }
  if (!dupes.length) {
    line("");
    line("No duplicate provisional codes — nothing to repair.");
    await mongoose.disconnect();
    return;
  }

  // ── plan: the OLDEST keeps the code, the rest are re-derived ──────────────
  const problems = [];
  const plan = [];
  const claimedThisRun = new Set();
  for (const [, list] of dupes) {
    const [keeper, ...movers] = list; // already addedAt-ascending
    claimedThisRun.add(String(keeper.draft.productCode).toLowerCase());
    for (const d of movers) {
      const category = String((d.draft && d.draft.category) || (d.suggested && d.suggested.category) || "").trim();
      const current = String(d.draft.productCode || "").trim();
      if (!category) { problems.push({ id: d._id, why: "no category on the draft" }); continue; }
      if (!parseCode(current)) { problems.push({ id: d._id, why: `current code "${current}" does not parse` }); continue; }
      const prefix = await prefixForCategory(category);
      if (!prefix) { problems.push({ id: d._id, why: `no derivable prefix for category "${category}"` }); continue; }

      // Re-derive against the LIVE catalogue, skipping anything already claimed
      // by another queued draft or by this run.
      let n = (await maxSuffixForPrefix(prefix)) + 1;
      let next = "";
      for (let guard = 0; guard < 10000; guard++, n++) {
        const candidate = `${prefix}${String(n).padStart(3, "0")}`;
        if (byCode.has(candidate) || claimedThisRun.has(candidate.toLowerCase())) continue;
        if (await isCodeTaken(candidate)) continue;
        next = candidate;
        break;
      }
      if (!next) { problems.push({ id: d._id, why: "could not derive a free code" }); continue; }
      claimedThisRun.add(next.toLowerCase());
      plan.push({ id: d._id, name: (d.draft && d.draft.name) || "", from: current, to: next, category });
    }
  }

  if (problems.length) {
    line("");
    line("ABORTING — these drafts are not shaped the way this script expects.");
    line("Nothing has been written. Resolve them before re-running:");
    for (const p of problems) line(`  ${String(p.id)}  — ${p.why}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  line("");
  line("Plan (oldest draft KEEPS the contested code; the rest move to free ones):");
  for (const p of plan) {
    line(`  ${String(p.id)}  ${p.from}  →  ${p.to}   ${String(p.name).slice(0, 40)}`);
  }

  if (!CONFIRM) {
    line("");
    line(`DRY RUN — nothing was written. ${plan.length} draft(s) would change.`);
    line("Re-run with --confirm on the EC2 box to repair.");
    await mongoose.disconnect();
    return;
  }

  line("");
  line("Repairing…");
  let changed = 0;
  for (const p of plan) {
    // Guarded on the code we planned against: if anything moved underneath us
    // since the plan was built, this row is skipped rather than overwritten.
    const res = await DecorDraft.updateOne(
      { _id: p.id, status: "queued", "draft.productCode": p.from },
      { $set: { "draft.productCode": p.to } }
    );
    if (res.modifiedCount) { changed += 1; line(`  ${p.from} → ${p.to}`); }
    else line(`  ${p.from} → ${p.to}   SKIPPED (draft changed since the plan was built)`);
  }

  // ── fresh count, so the run reports its own result ────────────────────────
  const after = await DecorDraft.find({ status: "queued" }, { "draft.productCode": 1 }).lean();
  const seen = new Map();
  for (const d of after) {
    const c = String((d.draft && d.draft.productCode) || "").trim();
    if (!c) continue;
    seen.set(c, (seen.get(c) || 0) + 1);
  }
  const stillDupe = [...seen.entries()].filter(([, n]) => n > 1);
  line("");
  line("After:");
  line(`  queued drafts: ${after.length}   distinct codes: ${seen.size}   still duplicated: ${stillDupe.length}`);
  for (const [c, n] of stillDupe) line(`    ${c} ×${n}`);
  line("");
  line(`Done — ${changed} draft(s) repaired. Re-run without --confirm to verify 0 duplicates.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e && e.message);
  process.exit(1);
});

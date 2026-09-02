/* READ-ONLY canary + audit for décor pricing integrity. No writes, ever.
 *
 *   node scripts/audit-look-chips.js
 *
 * Exit 0 = both canaries clean. Exit 2 = a canary tripped (details printed).
 *
 * CANARY 1 — looks with an empty priceChip. PlanService.addLook computes the
 * chip at add time, so through the API an empty chip on a decor-source look is
 * impossible. Non-zero here means something wrote plan looks around the
 * service layer (the 2026-08-26 dev seeding did exactly that: raw
 * `leadplans.updateOne($set:{looks})` with priceChip:'' hardcoded). See
 * "Engineering rules" in README.md: demo/QA data goes in through the service
 * layer, or it is not seeding, it is fabricating.
 *
 * CANARY 2 — tier[0] is the cheapest non-zero tier. The look chip renders
 * "from ₹tier[0]" (ruled 2026-09-02), and Build & Bill's default tier is [0]
 * (DraftEventService.js:702), so a product whose first tier is not its floor
 * makes "from" a lie and headlines the expensive tier. 13 known offenders are
 * with Rohaan for a ruling; new ones must not join them quietly.
 *
 * Also measures (report-only, no exit-code weight):
 *   D1  productTypes-vs-productInfo.variant price disagreement (variant is a
 *       stale copy — see the warning at models/Decor.js productInfo.variant)
 *   D3  published plansnapshots carrying an explicit empty chip (immutable —
 *       counted, NEVER rewritten by script; non-zero goes to Rohaan as a list)
 */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
  await mongoose.connect(url, { serverSelectionTimeoutMS: 10000 });
  const conn = mongoose.connection;
  console.log(`connected: host=${conn.host} db=${conn.name} (read-only)\n`);
  const decors = conn.db.collection("decors");
  const plans = conn.db.collection("leadplans");
  let tripped = false;

  // ── CANARY 1: empty chips on decor-source looks ────────────────────────────
  const lookStats = await plans.aggregate([
    { $unwind: "$looks" },
    { $group: {
      _id: { source: "$looks.source", empty: { $eq: [{ $ifNull: ["$looks.snapshot.priceChip", ""] }, ""] } },
      n: { $sum: 1 },
    } },
    { $sort: { "_id.source": 1 } },
  ]).toArray();
  console.log("looks across all plans, by source and chip state:");
  for (const r of lookStats) console.log(`  source=${r._id.source} chip ${r._id.empty ? "EMPTY" : "set"}: ${r.n}`);
  const emptyDecor = lookStats.find((r) => r._id.source === "decor" && r._id.empty);
  if (emptyDecor) {
    tripped = true;
    console.log(`\nCANARY 1 TRIPPED — ${emptyDecor.n} decor-source look(s) with an empty chip. Samples:`);
    const samples = await plans.aggregate([
      { $unwind: "$looks" },
      { $match: { "looks.source": "decor", $or: [{ "looks.snapshot.priceChip": "" }, { "looks.snapshot.priceChip": null }] } },
      { $project: { leadId: 1, look: "$looks" } },
      { $limit: 5 },
      { $lookup: { from: "decors", localField: "look.decorId", foreignField: "_id", as: "decor" } },
      { $unwind: { path: "$decor", preserveNullAndEmptyArrays: true } },
    ]).toArray();
    for (const s of samples) {
      const d = s.decor;
      const tier0 = d && d.productTypes && d.productTypes[0] ? d.productTypes[0].sellingPrice : "(none)";
      console.log(`  lead=${s.leadId} "${s.look.snapshot && s.look.snapshot.name}" addedBy=${s.look.addedBy} — product tier[0]=₹${tier0}${d ? "" : " (decor doc MISSING)"}`);
    }
  } else {
    console.log("\nCANARY 1 clean — no decor-source look has an empty chip.");
  }

  // ── CANARY 2: tier[0] is the cheapest non-zero tier ───────────────────────
  const all = await decors.find(
    {},
    { projection: { name: 1, category: 1, "productInfo.id": 1, "productTypes.name": 1, "productTypes.sellingPrice": 1 } }
  ).toArray();
  const offenders = [];
  let multi = 0;
  for (const d of all) {
    const priced = (d.productTypes || []).filter((t) => t && Number(t.sellingPrice) > 0);
    if (priced.length < 2) continue;
    multi++;
    const first0 = Number((d.productTypes[0] && d.productTypes[0].sellingPrice) || 0);
    const firstEff = first0 > 0 ? first0 : Number(priced[0].sellingPrice); // the chip's zero-guard
    const minP = Math.min(...priced.map((t) => Number(t.sellingPrice)));
    if (firstEff > minP) offenders.push(d);
  }
  console.log(`\nproducts with 2+ priced tiers: ${multi}; tier[0] not the cheapest: ${offenders.length}`);
  if (offenders.length) {
    tripped = true;
    console.log("CANARY 2 TRIPPED — tier order makes \"from ₹tier[0]\" false on:");
    for (const d of offenders) {
      const tiers = (d.productTypes || []).map((t) => `${t.name}=₹${t.sellingPrice}`).join(" | ");
      console.log(`  ${d.name} [${d.category}] code=${(d.productInfo && d.productInfo.id) || "—"}: ${tiers}`);
    }
    console.log("Do NOT auto-reorder: tier[0] is Build & Bill's default tier, so reordering changes the default quote. Rohaan rules per product.");
  } else {
    console.log("CANARY 2 clean — every multi-tier product leads with its floor.");
  }

  // ── D1: variant-vs-productTypes disagreement (stale-copy tracking) ────────
  const KEYMAP = { "artificial flowers": "artificialFlowers", "mixed flowers": "mixedFlowers", "natural flowers": "naturalFlowers" };
  const both = await decors.find(
    { "productInfo.variant": { $exists: true } },
    { projection: { category: 1, productTypes: 1, "productInfo.variant": 1 } }
  ).toArray();
  let bothPriced = 0, agree = 0, disagree = 0;
  const deltas = [], disByCat = new Map();
  for (const d of both) {
    const v = d.productInfo.variant || {};
    const vPriced = ["artificialFlowers", "mixedFlowers", "naturalFlowers"].some((k) => v[k] && v[k].sellingPrice > 0);
    const lPriced = (d.productTypes || []).some((t) => t && t.sellingPrice > 0);
    if (!vPriced || !lPriced) continue;
    bothPriced++;
    let comparable = 0, ds = [];
    for (const t of d.productTypes || []) {
      const key = KEYMAP[String(t.name || "").trim().toLowerCase()];
      if (!key || !v[key]) continue;
      const a = Number(t.sellingPrice) || 0, b = Number(v[key].sellingPrice) || 0;
      if (a <= 0 || b <= 0) continue;
      comparable++;
      if (a !== b) ds.push(a - b);
    }
    if (!comparable) continue;
    if (!ds.length) { agree++; continue; }
    disagree++;
    deltas.push(...ds);
    disByCat.set(d.category, (disByCat.get(d.category) || 0) + 1);
  }
  console.log(`\nD1. variant-vs-tiers: both priced=${bothPriced} agree=${agree} DISAGREE=${disagree}`);
  if (deltas.length) {
    const abs = deltas.map(Math.abs).sort((a, b) => a - b);
    console.log(`    |delta| n=${abs.length} min=₹${abs[0]} median=₹${abs[Math.floor(abs.length / 2)]} max=₹${abs[abs.length - 1]}`);
    for (const [c, n] of [...disByCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${c}: ${n}`);
  }

  // ── D3: published snapshots with an explicit empty chip (count only) ──────
  const snaps = conn.db.collection("plansnapshots");
  const snapTotal = await snaps.countDocuments({});
  const snapEmpty = await snaps.countDocuments({ $or: [
    { "content.looks": { $elemMatch: { priceChip: "" } } },
    { "content.functions.looks": { $elemMatch: { priceChip: "" } } },
    { "content.unassignedLooks": { $elemMatch: { priceChip: "" } } },
  ] });
  console.log(`\nD3. published plansnapshots: total=${snapTotal}, containing an explicit empty-chip look=${snapEmpty}`);
  if (snapEmpty) console.log("    (immutable — these go to Rohaan as a list, never to a rewrite script)");

  await mongoose.disconnect();
  process.exit(tripped ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

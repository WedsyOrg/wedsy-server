/**
 * PIN-LEVEL READ CACHE — "if an image is revisited the pricing must not differ".
 *
 * The vision model runs at temperature 1.0 with no determinism control, so two
 * reads of one photo disagree by ±25% on width. This suite proves the read is
 * taken ONCE and replayed.
 *
 * The stub is the point: analyseImage returns 24ft on its first call and 36ft on
 * its second. Those straddle the 30ft structure cliff, so if the cache ever fails
 * to hit, the price does not wobble — it jumps. Any assertion below that compares
 * two ladders would fail loudly rather than subtly.
 *
 *   node tests/decor-read-cache.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const sharp = require("sharp");

// ── Patch the vision layer BEFORE the controller destructures it ─────────────
// controllers/decor.js does `const { analyseImage } = require(...)` at load time,
// so the stub has to be installed on the module object first.
const decorVision = require("../services/decorVision");
const { postProcess } = decorVision;

let aiCalls = 0;
// Widths per successive AI call. 24ft is under the structure threshold, 36ft is
// over it — deliberately not a subtle difference.
const WIDTHS = [24, 36, 36, 24];
const rawRead = (widthFt) => ({
  isDecorProduct: true,
  category: "Stage",
  categoryConfidence: 0.9,
  style: "Modern",
  size: { length: 16, width: 12, confidence: 0.7 },
  complexity: { tier: "standard", confidence: 0.7, reasoning: "balanced" },
  observations: ["marigold garlands", "mirror panels"],
  minBuildWidth: { minWidthFt: 12, reasoning: "two sofas across", confidence: 0.7 },
  recommendedSize: { length: 16, width: 12 },
  stageMeasurements: {
    spanWidthFt: widthFt,
    floralRunFt: Math.round(widthFt * 0.8),
    confidence: 0.6,
    // readStageMeasurements prefers count × width-each over the span, so the two
    // signals have to agree or the width the engine uses is not the width here.
    repeatingElements: { count: widthFt / 6, estimatedWidthEachFt: 6 },
    widthToHeightRatio: 3,
    structureGeometry: "flat",
    sceneType: "indoor-hall",
    reasoning: "panels across the span",
  },
  occasion: { value: null, confidence: 0 },
});
// Returns exactly what the real pipeline would cache: postProcess's demo output.
decorVision.analyseImage = async () => {
  const w = WIDTHS[aiCalls] !== undefined ? WIDTHS[aiCalls] : 24;
  aiCalls++;
  return postProcess(rawRead(w), "demo");
};

const decor = require("../controllers/decor");
const DecorDraftService = require("../services/DecorDraftService");
const DecorImageRead = require("../models/DecorImageRead");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const { normalizeImageUrl } = require("../services/decorImageKey");

const TAG = `rc-${Date.now()}`;
let pass = 0,
  fail = 0;
const ok = (c, label) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
};
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

// Call the controller handler directly.
const post = (handler, body, auth) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      send(b) {
        resolve({ status: this.statusCode, body: b });
      },
      json(b) {
        resolve({ status: this.statusCode, body: b });
      },
    };
    Promise.resolve(handler({ body, auth }, res)).catch((e) =>
      resolve({ status: 500, body: { message: e.message } })
    );
  });

const PIN = (n) => `${TAG}-pin-${n}`;
const IMG = (n, size = "564x") => `https://i.pinimg.com/${size}/ab/cd/${TAG}${n}.jpg`;
const rowPrices = (b) => (b.ladder && b.ladder[0] && b.ladder[0].prices) || {};
const mid = (r) => Math.round((r.low + r.high) / 2 / 500) * 500;

const createdReads = [];
const createdDrafts = [];
const createdDecors = [];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  // Every cache miss downscales the image first, so `fetch` must return a real
  // JPEG for sharp to chew on. No network in this suite.
  const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#fff" } })
    .jpeg()
    .toBuffer();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => jpeg });
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";

  try {
    // ── 1. the same pin twice ────────────────────────────────────────────────
    console.log("1. revisiting a pin replays the read");
    const r1 = await post(decor.DemoPrice, { imageUrl: IMG(1), pinId: PIN(1), pinText: "reception stage" });
    eq(r1.status, 200, "first read succeeds");
    eq(aiCalls, 1, "…and cost exactly one AI call");
    eq(r1.body.read.origin, "fresh", "provenance: fresh");
    ok(!!r1.body.read.firstReadAt, "…carrying when it was first read");
    eq(r1.body.stageMeasurements.backdropWidthFt, 24, "read the 24ft width");

    const stored = await DecorImageRead.findOne({ pinId: PIN(1) }).lean();
    ok(!!stored, "the read was stored");
    createdReads.push(stored._id);
    eq(stored.normalizedUrl, normalizeImageUrl(IMG(1)), "keyed on the SHARED normalisation");
    eq(stored.mode, "demo", "stored as a demo read");

    // The cache lookup sits before the API-key guard, so a known image is
    // answerable with no key configured at all. Proving it here pins the
    // placement ruling, not just the behaviour.
    delete process.env.ANTHROPIC_API_KEY;
    // Same image at a DIFFERENT Pinterest size + a query string: the normaliser
    // has to collapse it onto the same key.
    const r2 = await post(decor.DemoPrice, {
      imageUrl: `${IMG(1, "originals")}?fit=cover`,
      pinId: PIN(1),
      pinText: "reception stage",
    });
    process.env.ANTHROPIC_API_KEY = "test-key";
    eq(r2.status, 200, "second read succeeds with NO api key configured");
    eq(aiCalls, 1, "…and made ZERO AI calls");
    eq(r2.body.read.origin, "cached", "provenance: cached");
    eq(
      JSON.stringify(r2.body.stageMeasurements),
      JSON.stringify(r1.body.stageMeasurements),
      "byte-identical measurements"
    );
    eq(JSON.stringify(rowPrices(r2.body)), JSON.stringify(rowPrices(r1.body)), "byte-identical ladder prices");
    // Everything except provenance must match — a replay is not a thinner reply.
    const strip = (b) => JSON.stringify({ ...b, read: undefined });
    eq(strip(r2.body), strip(r1.body), "the whole response is identical apart from `read`");
    eq(r2.body.floralRunPriced, r1.body.floralRunPriced, "presentation flags survive the replay");

    // Had the second call gone to the model it would have read 36ft, crossing the
    // structure threshold — so this is the price the cache actually prevented.
    ok(WIDTHS[1] === 36, "the stub's second read WOULD have been 36ft (the cliff)");

    // ── 2. category override: no read, no write ─────────────────────────────
    console.log("\n2. a category override neither reads nor writes the cache");
    const beforeCount = await DecorImageRead.countDocuments({});
    const ovr = await post(decor.DemoPrice, {
      imageUrl: IMG(2),
      pinId: PIN(2),
      categoryOverride: "Mandap",
      pinText: "mandap",
    });
    eq(ovr.status, 200, "override prices instantly");
    eq(aiCalls, 1, "…with no AI call");
    eq(ovr.body.category, "Mandap", "…and the asserted category");
    ok(!("read" in ovr.body), "no provenance claimed — nothing was read");
    eq(await DecorImageRead.countDocuments({}), beforeCount, "NOTHING was written to the cache");
    eq(await DecorImageRead.countDocuments({ pinId: PIN(2) }), 0, "the overridden pin has no entry");

    // The staff correction must not have poisoned a later genuine read.
    const genuine = await post(decor.DemoPrice, { imageUrl: IMG(2), pinId: PIN(2) });
    eq(genuine.body.category, "Stage", "a later genuine read of that pin still reads Stage");
    eq(aiCalls, 2, "…and it paid for its own read");
    const e2 = await DecorImageRead.findOne({ pinId: PIN(2) }).lean();
    createdReads.push(e2._id);
    eq(e2.analysis.category, "Stage", "the cache holds the MODEL's read, not the override");

    // ── 3. reanalyse overwrites ─────────────────────────────────────────────
    console.log("\n3. reanalyse forces a fresh read and overwrites the entry");
    const before = await DecorImageRead.findOne({ pinId: PIN(1) }).lean();
    eq(before.reads, 1, "one read so far");
    const re = await post(decor.DemoPrice, {
      imageUrl: IMG(1),
      pinId: PIN(1),
      pinText: "reception stage",
      reanalyse: true,
    });
    eq(aiCalls, 3, "reanalyse paid for a new AI call");
    eq(re.body.stageMeasurements.backdropWidthFt, 36, "the response carries the NEW read");
    ok(
      JSON.stringify(rowPrices(re.body)) !== JSON.stringify(rowPrices(r1.body)),
      "…and the price moved, as a 24ft→36ft re-read should"
    );
    const after = await DecorImageRead.findOne({ pinId: PIN(1) }).lean();
    eq(String(after._id), String(before._id), "the SAME entry was overwritten, not duplicated");
    eq(after.reads, 2, "reads incremented");
    eq(after.analysis.stageMeasurements.backdropWidthFt, 36, "the stored read is the new one");
    ok(!!after.lastReanalysedAt, "lastReanalysedAt stamped");
    eq(await DecorImageRead.countDocuments({ pinId: PIN(1) }), 1, "still exactly one entry for the pin");

    // …and the overwrite is what subsequent lookups serve.
    const r3 = await post(decor.DemoPrice, { imageUrl: IMG(1), pinId: PIN(1), pinText: "reception stage" });
    eq(aiCalls, 3, "the next visit is free again");
    eq(r3.body.stageMeasurements.backdropWidthFt, 36, "and serves the re-read, not the original");

    // ── 4. an approved pin answers from the live product ────────────────────
    console.log("\n4. a pin already in the store returns the LIVE product price");
    const product = await Decor.create({
      category: `${TAG}-cat`,
      name: `${TAG} Ivory Cascade`,
      unit: "Pc",
      image: "https://s3.test/a.jpg",
      thumbnail: "https://s3.test/a.jpg",
      productTypes: [{ name: "Artificial Flowers", costPrice: 0, sellingPrice: 55000, discount: 0 }],
      productInfo: { id: `${TAG}c1`, measurements: { length: 16, width: 12 } },
    });
    createdDecors.push(product._id);
    const appr = await DecorDraft.create({
      sourceImage: { url: IMG(4), pinId: PIN(4), normalizedUrl: normalizeImageUrl(IMG(4)), pinText: "" },
      storedImage: "https://s3.test/a.jpg",
      status: "approved",
      publishedDecorId: product._id,
      pricing: { finalPrice: 55000 },
    });
    createdDrafts.push(appr._id);

    const st = await post(decor.DemoPrice, { imageUrl: IMG(4), pinId: PIN(4) });
    eq(st.status, 200, "store reply succeeds");
    eq(aiCalls, 3, "…with no AI call — it is a product, not an estimate");
    eq(st.body.read.origin, "from-store", "provenance: from-store");
    eq(st.body.read.product.code, `${TAG}c1`, "…naming the product code");
    eq(rowPrices(st.body).artificial.low, 55000, "the ladder IS the live selling price");
    eq(rowPrices(st.body).artificial.high, 55000, "…quoted as a point, not a range");
    eq(st.body.floralRunPriced, false, "nothing was floral-run estimated");
    eq(st.body.recommendedSize, "16x12", "the product's own size is the recommendation");

    // The deliberate exception to "a revisit must not differ": a catalogue edit
    // is the wanted answer, not a stale-cache bug.
    await Decor.updateOne(
      { _id: product._id },
      { $set: { "productTypes.0.sellingPrice": 61000 } }
    );
    const st2 = await post(decor.DemoPrice, { imageUrl: IMG(4), pinId: PIN(4) });
    eq(rowPrices(st2.body).artificial.low, 61000, "a catalogue price edit is reflected immediately");
    eq(aiCalls, 3, "…still no AI call");

    // A draft pointing at a deleted product must not be an answer.
    const orphanImg = IMG(5);
    const orphanDraft = await DecorDraft.create({
      sourceImage: { url: orphanImg, pinId: PIN(5), normalizedUrl: normalizeImageUrl(orphanImg), pinText: "" },
      storedImage: "https://s3.test/b.jpg",
      status: "approved",
      publishedDecorId: new mongoose.Types.ObjectId(),
    });
    createdDrafts.push(orphanDraft._id);
    const orph = await post(decor.DemoPrice, { imageUrl: orphanImg, pinId: PIN(5) });
    eq(orph.status, 200, "an orphaned approval still gets a price");
    eq(orph.body.read.origin, "fresh", "…by falling through to a real read");
    eq(aiCalls, 4, "…which cost one AI call");
    const orphEntry = await DecorImageRead.findOne({ pinId: PIN(5) }).lean();
    if (orphEntry) createdReads.push(orphEntry._id);

    // ── 5. A2S takes the panel's number ─────────────────────────────────────
    console.log("\n5. A2S consumes the cached read and pre-fills the PANEL's price");
    // Warm the cache exactly as the panel does.
    aiCalls = 0;
    WIDTHS.length = 0;
    WIDTHS.push(24);
    const panel = await post(decor.DemoPrice, {
      imageUrl: IMG(6),
      pinId: PIN(6),
      pinText: "reception stage",
    });
    eq(panel.body.read.origin, "fresh", "panel priced the pin");
    const panelEntry = await DecorImageRead.findOne({ pinId: PIN(6) }).lean();
    createdReads.push(panelEntry._id);
    // ⚠️ CHANGED 2026-08-21. This used to read ladder[0] — the FLORAL-RUN row —
    // which the panel stopped displaying when it moved to size options, so the
    // quote and the display had drifted apart (₹51,000 quoted vs ₹93,333 in the
    // tier table on a real pin). The quote now comes from the rung the panel
    // actually shows and badges RECOMMENDED, so that is what this compares to.
    const recRung = (panel.body.sizeOptions || []).find((o) => o.size === panel.body.recommendedSize)
      || (panel.body.sizeOptions || [])[0];
    ok(!!recRung, "the panel displayed a size rung");
    // NOTE: this fixture's recommendedSize (16x12) is NOT among the shown rungs —
    // the caption is "reception stage", and the occasion FLOOR evicts everything
    // under 20ft after the swap runs. That is swap-first / floor-last behaving
    // exactly as ruled, and it means "the recommendation is always one of the two
    // shown" holds only BEFORE the floor. So the quote falls back to the rung
    // nearest the read, and what matters is that it is one the panel displayed.
    ok(
      (panel.body.sizeOptions || []).some((o) => o.size === recRung.size),
      "…and the quote lands on a rung the panel actually displayed"
    );
    const quotedRange = recRung.prices.artificial;
    ok(!!quotedRange, "the panel quoted an artificial range on it");
    ok(
      JSON.stringify(quotedRange) !== JSON.stringify(rowPrices(panel.body).artificial),
      "…which is a DIFFERENT figure from the floral-run row — the drift this fixes"
    );

    // Stub A2S's expensive edges. runPricingBrain THROWS: if A2S still runs its
    // own vision call on a cache hit, this test fails instead of quietly pricing
    // the same photo twice.
    DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({
      url: `https://s3.test/decor-drafts/${id}.jpg`,
      buffer: jpeg,
    });
    DecorDraftService.__deps.toAnalysisBase64 = async () => "FAKEBASE64";
    DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
    DecorDraftService.__deps.analyseForCopy = async () => ({
      suggestedName: "Ivory Cascade",
      description: "d",
      tags: ["floral"],
      included: ["Decor as shown in image"],
      category: "Stage",
      style: "Modern",
      colors: ["ivory"],
      flowers: ["rose"],
      fabric: [],
    });
    DecorDraftService.__deps.runPricingBrain = async () => {
      throw new Error("A2S ran its own vision call — the cached read was ignored");
    };

    const draft = await DecorDraftService.createDraft(
      { imageUrl: IMG(6), pinId: PIN(6), pinText: "reception stage" },
      null
    );
    createdDrafts.push(draft._id);
    eq(aiCalls, 1, "A2S made ZERO extra vision calls (the panel's read was reused)");
    eq(draft.sourceRead.source, "cache", "provenance recorded: the read came from the cache");
    eq(String(draft.sourceRead.cacheId), String(panelEntry._id), "…naming WHICH entry");
    eq(
      new Date(draft.sourceRead.firstReadAt).getTime(),
      new Date(panelEntry.firstReadAt).getTime(),
      "…and when the image was first read"
    );
    ok(!!draft.sourceRead.usedAt, "…and when this draft consumed it");
    eq(draft.aiAnalysis.pricing.analysisMode, "demo", "the stored analysis is marked as the demo read");
    eq(
      draft.aiAnalysis.pricing.analysis.stageMeasurements.backdropWidthFt,
      panel.body.stageMeasurements.backdropWidthFt,
      "the draft carries the SAME read the client was quoted from"
    );

    // THE REQUIREMENT: the modal's pre-filled price is the panel's midpoint.
    const pq = draft.pricing.panelQuote;
    ok(!!pq, "a panel quote was recorded");
    eq(pq.tier, "artificial", "quoted on the tier the publish step names");
    eq(pq.low, quotedRange.low, "low matches the panel");
    eq(pq.high, quotedRange.high, "high matches the panel");
    eq(pq.midpoint, mid(quotedRange), "the pre-filled price IS the midpoint of the panel's range");
    ok(pq.headroomApplied > 1, "…with the negotiating headroom still in it");
    ok((panel.body.sizeOptions || []).some((o) => o.size === pq.size), "…quoted on a DISPLAYED rung");
    eq(pq.basis, "size-ladder", "…and records that it came from the size ladder");
    eq(pq.tierPrices.artificial.midpoint, pq.midpoint, "tierPrices agrees with the headline midpoint");
    ok(
      pq.midpoint > quotedRange.low && pq.midpoint < quotedRange.high,
      "…and it sits inside the quoted range"
    );
    // The draft engine's own ladder is untouched beside it — the training "before".
    ok(!!draft.pricing.aiSuggested, "the draft engine's ladder is still stored separately");

    // Immutability extends to both new evidence fields.
    const eQuote = await DecorDraft.updateOne(
      { _id: draft._id },
      { $set: { "pricing.panelQuote.midpoint": 1 } }
    ).then(
      () => null,
      (e) => e
    );
    ok(eQuote && /immutable/i.test(eQuote.message), "pricing.panelQuote is immutable");
    const eSrc = await DecorDraft.updateOne({ _id: draft._id }, { $set: { "sourceRead.source": "fresh" } }).then(
      () => null,
      (e) => e
    );
    ok(eSrc && /immutable/i.test(eSrc.message), "sourceRead is immutable");

    // A2S with NO cached read must not invent a quote.
    DecorDraftService.__deps.runPricingBrain = async () => ({
      analysis: postProcess(rawRead(24), "full"),
      pricing: { category: "Stage", suggested: { artificial: 40000 } },
      fallbacks: [],
      rejected: false,
    });
    const cold = await DecorDraftService.createDraft(
      { imageUrl: IMG(7), pinId: PIN(7), pinText: "reception stage" },
      null
    );
    createdDrafts.push(cold._id);
    eq(cold.sourceRead.source, "fresh", "a cold A2S click reads for itself");
    eq(cold.pricing.panelQuote, null, "…and records NO panel quote — nothing was ever quoted");
    eq(cold.aiAnalysis.pricing.analysisMode, "full", "…marked as a full read");
  } catch (e) {
    fail++;
    console.error("  ✗ threw:", e);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
    await DecorImageRead.deleteMany({ $or: [{ pinId: new RegExp(`^${TAG}`) }, { _id: { $in: createdReads } }] });
    await DecorDraft.deleteMany({ _id: { $in: createdDrafts } });
    await Decor.deleteMany({ _id: { $in: createdDecors } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

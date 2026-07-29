// Catalogue embedding — retrieval layer, one-time build. STANDALONE, run
// manually. Reads the LOCAL dev DB only; writes ONE JSON file to disk. NO writes
// to any database, no writes to S3.
//
//   node scripts/embed-catalogue.js            # embed the whole catalogue
//   node scripts/embed-catalogue.js --limit 20 # smoke test on the first 20 images
//
// Needs GEMINI_API_KEY (dotenv loaded if present). Embeds every catalogue image
// (image + thumbnail + additionalImages; seoTags.image is skipped as a dup of
// the main image) with Gemini Embedding 2 @ 768 dims, unit-normalised, and
// writes ~/Desktop/decor-embeddings-v1.json for brute-force dot-product search.

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  MODEL,
  DIMENSIONS,
  MAX_EDGE,
  fetchImageBuffer,
  preprocessToBase64,
  unitNormalize,
  embedOne,
  embedBatch,
} = require("./lib/gemini-embed");

// ── config / guards ──────────────────────────────────────────────────────────
const URI = process.env.DECOR_DB_URI || "mongodb://localhost:27017/wedsy-db-dev";
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1):27017\/wedsy-db-dev$/.test(URI)) {
  console.error(`Refusing to run against a non-local DB URI: ${URI}`);
  process.exit(1);
}
const OUT = process.env.OUT || path.join(process.env.HOME || ".", "Desktop", "decor-embeddings-v1.json");
const BATCH = Number(process.env.EMBED_BATCH) || 16;
const BATCH_PAUSE_MS = Number(process.env.EMBED_BATCH_PAUSE_MS) || 250;
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : (process.env.LIMIT ? Number(process.env.LIMIT) : 0);

const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s.trim());

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`DB: ${mongoose.connection.host}/${mongoose.connection.name}`);
  console.log(`Model: ${MODEL} @ ${DIMENSIONS} dims · max edge ${MAX_EDGE}px · batch ${BATCH}\n`);
  const Decor = require("../models/Decor");

  const docs = await Decor.find(
    {},
    "image thumbnail additionalImages category productInfo.id"
  ).lean();

  // Build the image task list: image (main), thumbnail, each additionalImages.
  // seoTags.image is intentionally NOT pulled (duplicate of the main image).
  // Skip exact-duplicate URLs so we never embed the identical file twice.
  const tasks = [];
  const seenUrls = new Set();
  let dupSkipped = 0;
  for (const d of docs) {
    const productId = String(d._id);
    const productCode = (d.productInfo && d.productInfo.id) || "";
    const category = d.category || "";
    const add = (imageUrl, imageType) => {
      if (!isUrl(imageUrl)) return;
      const u = imageUrl.trim();
      if (seenUrls.has(u)) { dupSkipped++; return; }
      seenUrls.add(u);
      tasks.push({ productId, productCode, category, imageUrl: u, imageType });
    };
    add(d.image, "main");
    add(d.thumbnail, "thumbnail");
    (Array.isArray(d.additionalImages) ? d.additionalImages : []).forEach((u, i) =>
      add(u, `additional[${i}]`)
    );
  }

  const work = LIMIT > 0 ? tasks.slice(0, LIMIT) : tasks;
  console.log(
    `${docs.length} products · ${tasks.length} distinct image URLs` +
      (dupSkipped ? ` (${dupSkipped} exact-dup URLs skipped)` : "") +
      (LIMIT > 0 ? ` · LIMIT ${LIMIT}` : "") +
      `\n`
  );

  const vectors = [];
  const failures = []; // { imageUrl, productCode, stage, reason }
  let done = 0;
  const progress = () => {
    if (done % 100 === 0 || done === work.length) {
      console.log(`  …${done}/${work.length} images  (ok ${vectors.length}, failed ${failures.length})`);
    }
  };

  let batchDisabled = false; // flips true after a non-retryable batch error

  for (let i = 0; i < work.length; i += BATCH) {
    const slice = work.slice(i, i + BATCH);

    // Fetch + preprocess this slice concurrently. A per-image failure drops just
    // that image (recorded), never the batch.
    const prepared = await Promise.all(
      slice.map(async (task) => {
        try {
          const buf = await fetchImageBuffer(task.imageUrl);
          const base64 = await preprocessToBase64(buf);
          return { task, base64 };
        } catch (e) {
          failures.push({ imageUrl: task.imageUrl, productCode: task.productCode, stage: "fetch/preprocess", reason: e.message });
          return null;
        }
      })
    );
    const ready = prepared.filter(Boolean);
    if (!ready.length) { done += slice.length; progress(); continue; }

    // Embed — batch where supported, else per-image. If a batch fails with a
    // non-retryable error (e.g. batch unsupported), disable batching hereafter.
    let embeddings = null;
    if (!batchDisabled) {
      try {
        embeddings = await embedBatch(ready.map((r) => r.base64));
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
          batchDisabled = true;
          console.log(`  (batch embedding unavailable — ${e.message}; falling back to per-image)`);
        }
        embeddings = null;
      }
    }
    if (!embeddings) {
      embeddings = [];
      for (const r of ready) {
        try {
          embeddings.push(await embedOne(r.base64));
        } catch (e) {
          embeddings.push(null);
          failures.push({ imageUrl: r.task.imageUrl, productCode: r.task.productCode, stage: "embed", reason: e.message });
        }
      }
    }

    ready.forEach((r, idx) => {
      const raw = embeddings[idx];
      if (!Array.isArray(raw)) {
        if (!failures.some((f) => f.imageUrl === r.task.imageUrl)) {
          failures.push({ imageUrl: r.task.imageUrl, productCode: r.task.productCode, stage: "embed", reason: "no vector returned" });
        }
        return;
      }
      vectors.push({
        productId: r.task.productId,
        productCode: r.task.productCode,
        category: r.task.category,
        imageUrl: r.task.imageUrl,
        imageType: r.task.imageType,
        vector: unitNormalize(raw),
      });
    });

    done += slice.length;
    progress();
    if (i + BATCH < work.length && BATCH_PAUSE_MS) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  // ── write output ────────────────────────────────────────────────────────────
  const output = {
    model: MODEL,
    dimensions: DIMENSIONS,
    createdAt: new Date().toISOString(),
    count: vectors.length,
    vectors,
  };
  fs.writeFileSync(OUT, JSON.stringify(output));

  // ── summary ─────────────────────────────────────────────────────────────────
  const productsCovered = new Set(vectors.map((v) => v.productId)).size;
  const byType = vectors.reduce((m, v) => ((m[v.imageType.replace(/\[\d+\]/, "[]")] = (m[v.imageType.replace(/\[\d+\]/, "[]")] || 0) + 1), m), {});
  console.log(`\n${"=".repeat(60)}\nSUMMARY\n${"=".repeat(60)}`);
  console.log(`images attempted : ${work.length}`);
  console.log(`embedded ok      : ${vectors.length}  (by type: ${JSON.stringify(byType)})`);
  console.log(`products covered : ${productsCovered} / ${docs.length}`);
  console.log(`failures         : ${failures.length}`);
  if (failures.length) {
    const byReason = failures.reduce((m, f) => ((m[f.reason] = (m[f.reason] || 0) + 1), m), {});
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).forEach(([reason, n]) =>
      console.log(`    ${String(n).padStart(4)}  ${reason}`)
    );
    console.log("  first few failed URLs:");
    failures.slice(0, 8).forEach((f) => console.log(`    [${f.stage}] ${f.productCode} ${f.imageUrl} — ${f.reason}`));
  }
  console.log(`\nwrote ${OUT}  (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

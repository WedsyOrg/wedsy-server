// Retrieval sanity-check tool. Embeds ONE query image the SAME way as the
// catalogue, loads the embeddings JSON, and prints the top-10 nearest catalogue
// images by dot product (= cosine, since everything is unit-normalised).
//
//   node scripts/query-embeddings.js <local-image-path | image-url>
//   node scripts/query-embeddings.js ~/Desktop/vision-test/somepin.jpg
//   node scripts/query-embeddings.js https://.../inspiration.jpg
//
// No DB, no writes. Needs GEMINI_API_KEY. Reads ~/Desktop/decor-embeddings-v1.json
// (override with EMBEDDINGS=/path or a 2nd arg).

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");
const {
  MODEL,
  DIMENSIONS,
  fetchImageBuffer,
  preprocessToBase64,
  unitNormalize,
  dot,
  embedOne,
} = require("./lib/gemini-embed");

const TOP_N = 10;

(async () => {
  const query = process.argv[2];
  const embFile =
    process.argv[3] ||
    process.env.EMBEDDINGS ||
    path.join(process.env.HOME || ".", "Desktop", "decor-embeddings-v1.json");
  if (!query) {
    console.error("Usage: node scripts/query-embeddings.js <local-image-path | image-url> [embeddings.json]");
    process.exit(1);
  }
  if (!fs.existsSync(embFile)) {
    console.error(`Embeddings file not found: ${embFile}\nRun scripts/embed-catalogue.js first.`);
    process.exit(1);
  }

  // Load the index.
  const index = JSON.parse(fs.readFileSync(embFile, "utf8"));
  const vectors = index.vectors || [];
  console.error(`Index: ${index.model} @ ${index.dimensions}d · ${vectors.length} vectors (built ${index.createdAt})`);
  if (index.model !== MODEL || index.dimensions !== DIMENSIONS) {
    console.error(`⚠️  query model/dims (${MODEL}@${DIMENSIONS}) differ from the index — results will be meaningless.`);
  }

  // Load the query image: local path or URL.
  let buffer;
  if (/^https?:\/\//i.test(query)) {
    buffer = await fetchImageBuffer(query);
  } else {
    const p = query.replace(/^~(?=$|\/)/, process.env.HOME || "~");
    if (!fs.existsSync(p)) { console.error(`No such file: ${p}`); process.exit(1); }
    buffer = fs.readFileSync(p);
  }

  const base64 = await preprocessToBase64(buffer);
  const q = unitNormalize(await embedOne(base64));

  const ranked = vectors
    .map((v) => ({ v, score: dot(q, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  console.log(`\nTop ${TOP_N} matches for: ${query}\n`);
  console.log("  " + "#".padEnd(4) + "code".padEnd(10) + "category".padEnd(16) + "imageType".padEnd(16) + "score");
  ranked.forEach((r, i) => {
    console.log(
      "  " +
        String(i + 1).padEnd(4) +
        (r.v.productCode || "—").padEnd(10) +
        (r.v.category || "—").padEnd(16) +
        (r.v.imageType || "—").padEnd(16) +
        r.score.toFixed(4)
    );
  });
  console.log("");
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});

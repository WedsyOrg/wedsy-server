// Phase B vision accuracy harness. Runs every image in a folder through the
// vision layer, prints the JSON per image, then a distribution SUMMARY
// (isDecorProduct, category, complexity tier, size). This is the "testable
// accuracy before any UI" gate from the spec.
//
//   Run: node scripts/decor-vision-test.js <folder> [full|demo]
//   e.g. node scripts/decor-vision-test.js ~/Desktop/vision-test full
//        node scripts/decor-vision-test.js ~/Desktop/vision-test-negative
//
// Needs ANTHROPIC_API_KEY (dotenv loaded if present). Each image is a real Haiku
// call. No DB, no pricing — vision only.

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");
const { analyseImage, MODEL } = require("../services/decorVision");

const EXT_MEDIA = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif",
};

const tally = (rows, keyFn) => {
  const m = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (k == null) return;
    m.set(k, (m.get(k) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const printTally = (label, pairs, total) => {
  console.error(`\n${label}:`);
  if (!pairs.length) { console.error("  (none)"); return; }
  pairs.forEach(([k, n]) =>
    console.error(`  ${String(k).padEnd(20)} ${String(n).padStart(3)}  ${((100 * n) / total).toFixed(0)}%`)
  );
};

(async () => {
  const folder = process.argv[2];
  const mode = process.argv[3] === "demo" ? "demo" : "full";
  if (!folder) {
    console.error("Usage: node scripts/decor-vision-test.js <folder-of-images> [full|demo]");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — export it (or add to .env) first.");
    process.exit(1);
  }
  const dir = folder.replace(/^~(?=$|\/)/, process.env.HOME || "~");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir)
    .filter((f) => EXT_MEDIA[path.extname(f).toLowerCase()])
    .sort();
  if (!files.length) {
    console.error(`No images (${Object.keys(EXT_MEDIA).join(", ")}) found in ${dir}`);
    process.exit(1);
  }

  console.error(`Model: ${MODEL}  ·  mode: ${mode}  ·  ${files.length} image(s) in ${dir}\n`);

  const results = []; // { file, analysis, ms }
  const failures = [];
  const times = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const media = EXT_MEDIA[path.extname(file).toLowerCase()];
    const started = process.hrtime.bigint();
    try {
      const dataUri = `data:${media};base64,${fs.readFileSync(full).toString("base64")}`;
      const analysis = await analyseImage({ imageBase64: dataUri, mode });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      times.push(ms);
      results.push({ file, analysis, ms });
      console.log(`\n===== ${file}  (${ms.toFixed(0)} ms) =====`);
      console.log(JSON.stringify(analysis, null, 2));
    } catch (e) {
      failures.push({ file, error: e.code || e.name || "error", message: e.message });
      console.log(`\n===== ${file}  (FAILED) =====`);
      console.log(JSON.stringify({ error: e.code || e.name, message: e.message, raw: e.raw }, null, 2));
    }
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const ok = results.map((r) => r.analysis);
  const n = ok.length;
  console.error(`\n${"=".repeat(60)}\nSUMMARY — ${dir}\n${"=".repeat(60)}`);
  console.error(`analysed ${n}/${files.length}  ·  failures ${failures.length}`);
  if (times.length) {
    const sorted = times.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.error(`latency ms: min ${Math.min(...times).toFixed(0)} · median ${median.toFixed(0)} · max ${Math.max(...times).toFixed(0)}`);
  }

  const decor = ok.filter((a) => a.isDecorProduct);
  const nonDecor = ok.filter((a) => !a.isDecorProduct);
  console.error(`\nisDecorProduct: true ${decor.length} · false ${nonDecor.length}`);

  // Full roster — isDecorProduct for EVERY image.
  console.error("\nroster (file → isDecorProduct → category):");
  results.forEach((r) =>
    console.error(`  ${r.analysis.isDecorProduct ? "TRUE " : "false"}  ${r.file}  ${r.analysis.category == null ? "—" : r.analysis.category}`)
  );
  if (nonDecor.length) {
    console.error("  rejection reasoning:");
    results.filter((r) => !r.analysis.isDecorProduct).forEach((r) =>
      console.error(`    ${r.file}: ${r.analysis.complexity.reasoning || "no reasoning"}`)
    );
  }

  printTally("category (décor only)", tally(decor, (a) => a.category), decor.length || 1);
  printTally("complexity tier (décor only)", tally(decor, (a) => a.complexity.tier), decor.length || 1);
  printTally(
    "size — Stage/Mandap only",
    tally(decor.filter((a) => a.category === "Stage" || a.category === "Mandap"),
      (a) => `${a.category} ${a.size.length}x${a.size.width}`),
    decor.filter((a) => a.category === "Stage" || a.category === "Mandap").length || 1
  );
  if (failures.length) {
    console.error("\nfailures:");
    failures.forEach((f) => console.error(`  ${f.file}: ${f.error} — ${f.message}`));
  }
  console.error("");
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});

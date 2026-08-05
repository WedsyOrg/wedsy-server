// Compare vision models on dimension estimation — READ-ONLY, stdout only.
//
// Runs the SAME local images through claude-haiku-4-5-20251001 and
// claude-sonnet-5 using the real production pipeline (same prompt, schema,
// post-processing, and 800px downscale as POST /decor/demo-price) and prints
// the measurement fields side by side. Drop the pins that failed into a folder
// and point this at it:
//
//   ANTHROPIC_API_KEY=... node scripts/compare-vision-models.js ./failed-pins
//
// No DB access, no writes anywhere.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-5"];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_EDGE = Number(process.env.DEMO_IMAGE_MAX_EDGE) || 800; // matches the controller

// decorVision reads its model at require time — reload it per model so the
// production code stays untouched (no analyseImage model parameter needed).
const loadAnalyseImage = (model) => {
  process.env.DECOR_VISION_MODEL = model;
  delete require.cache[require.resolve("../services/decorVision")];
  return require("../services/decorVision").analyseImage;
};

// Same downscale as the live path (EXIF-corrected, 800px longest edge, jpeg 85).
const downscaleToBase64 = async (filePath) => {
  const out = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return out.toString("base64");
};

const pct = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : "—");
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : String(v));

// One comparison row per field the founder cares about.
const rowsFor = (a) => {
  if (!a) return {};
  if (a.error) return { error: a.error };
  const sm = a.stageMeasurements || {};
  const occ = a.occasion || {};
  return {
    category: `${a.category || "—"} (${pct(a.categoryConfidence)})`,
    occasion: `${occ.value || "—"} (${pct(occ.confidence)})`,
    backdropWidthFt: num(sm.backdropWidthFt),
    // The width working, so a wrong total is attributable to the count or to
    // the per-unit size — the two fail very differently.
    "width working": sm.repeatingElements
      ? `${sm.repeatingElements.count} ${sm.repeatingElements.type} × ${sm.repeatingElements.estimatedWidthEachFt}ft`
      : `span only`,
    sceneType: `${sm.sceneType || "—"}${sm.widthDisputed ? " ⚠DISPUTED" : ""}`,
    "spanWidthFt (cross-check)": num(sm.spanWidthFt),
    floralRunFt: num(sm.floralRunFt),
    widthToHeightRatio: num(sm.widthToHeightRatio),
    rawHeightEstimateFt: num(sm.rawHeightEstimateFt),
    "estimatedHeightFt (snapped)": num(sm.estimatedHeightFt),
    "measurement confidence": pct(sm.confidence),
    "latency ms": num(a._ms),
    _reasoning: sm.reasoning || "",
  };
};

const COL = 34;
const pad = (s) => String(s).padEnd(COL).slice(0, COL);

(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error("Usage: node scripts/compare-vision-models.js <folder-of-images>");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
  if (!files.length) {
    console.error(`No images (${[...IMAGE_EXTS].join(", ")}) found in ${dir}`);
    process.exit(1);
  }
  console.log(`${files.length} image(s) · ${MODELS.join("  vs  ")} · demo mode, ${MAX_EDGE}px downscale\n`);

  // Run all images through one model before switching (keeps each model's
  // prompt cache warm across the set, like production traffic would).
  const results = {}; // file -> model -> analysis
  for (const model of MODELS) {
    const analyseImage = loadAnalyseImage(model);
    for (const file of files) {
      results[file] = results[file] || {};
      try {
        const imageBase64 = await downscaleToBase64(path.join(dir, file));
        const t0 = Date.now();
        const analysis = await analyseImage({ imageBase64, mode: "demo" });
        analysis._ms = Date.now() - t0;
        results[file][model] = analysis;
      } catch (e) {
        results[file][model] = { error: e && e.message ? e.message : String(e) };
      }
    }
  }

  for (const file of files) {
    console.log("═".repeat(24 + COL * 2));
    console.log(file);
    console.log("─".repeat(24 + COL * 2));
    const perModel = MODELS.map((m) => rowsFor(results[file][m]));
    console.log(`${pad("field").slice(0, 24).padEnd(24)}${MODELS.map(pad).join("")}`);
    const fields = [
      "category", "occasion", "backdropWidthFt", "width working", "sceneType",
      "spanWidthFt (cross-check)", "floralRunFt", "widthToHeightRatio",
      "rawHeightEstimateFt", "estimatedHeightFt (snapped)", "measurement confidence", "latency ms",
    ];
    for (const f of fields) {
      console.log(`${f.padEnd(24)}${perModel.map((r) => pad(r.error ? (f === "category" ? `ERROR: ${r.error}` : "—") : r[f] ?? "—")).join("")}`);
    }
    MODELS.forEach((m, i) => {
      const r = perModel[i];
      if (r && r._reasoning) console.log(`\nreasoning (${m}):\n  ${r._reasoning}`);
    });
    console.log();
  }
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

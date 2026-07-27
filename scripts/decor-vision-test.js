// Phase B vision accuracy harness. Runs every image in a folder through the
// vision layer and prints the strict JSON per image. Vision only — no DB, no
// pricing (that needs a live catalog); this is the "testable accuracy before
// any UI" step from the spec: eyeball category / size / complexity calls.
//
//   Run: node scripts/decor-vision-test.js <folder>
//   e.g. node scripts/decor-vision-test.js ~/Desktop/pinterest-boards
//
// Needs ANTHROPIC_API_KEY in env (dotenv is loaded if present). Each image is a
// real Haiku call, so this costs a few paise per image — point it at a folder
// of 20-30 test images, not the whole catalogue.

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");
const { analyseImage, MODEL } = require("../services/decorVision");

const EXT_MEDIA = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

(async () => {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: node scripts/decor-vision-test.js <folder-of-images>");
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

  const files = fs
    .readdirSync(dir)
    .filter((f) => EXT_MEDIA[path.extname(f).toLowerCase()])
    .sort();

  if (!files.length) {
    console.error(`No images (${Object.keys(EXT_MEDIA).join(", ")}) found in ${dir}`);
    process.exit(1);
  }

  console.error(`Model: ${MODEL}  ·  ${files.length} image(s) in ${dir}\n`);

  let okCount = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    const media = EXT_MEDIA[path.extname(file).toLowerCase()];
    const started = process.hrtime.bigint();
    try {
      const dataUri = `data:${media};base64,${fs.readFileSync(full).toString("base64")}`;
      const analysis = await analyseImage({ imageBase64: dataUri });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`\n===== ${file}  (${ms.toFixed(0)} ms) =====`);
      console.log(JSON.stringify(analysis, null, 2));
      okCount++;
    } catch (e) {
      console.log(`\n===== ${file}  (FAILED) =====`);
      console.log(JSON.stringify({ error: e.code || e.name || "error", message: e.message, raw: e.raw }, null, 2));
    }
  }

  console.error(`\nDone. ${okCount}/${files.length} analysed.`);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});

/**
 * VISION RETRY SEMANTICS — overload AND malformed JSON.
 *
 * The vision call is the single most expensive failure in the décor path: on an
 * A2S cache miss a failed call loses the whole draft — pricing, copy and the
 * human's click. This suite pins exactly which failures are re-asked, how many
 * times, and what surfaces when the budget runs out.
 *
 * PURE — the Anthropic SDK is replaced with a scripted stub, so no network, no
 * API key and no non-determinism. Every case drives the real analyseImage().
 *
 *   node tests/decor-vision-retry.test.js
 */
process.env.ANTHROPIC_API_KEY = "test-key";

const Module = require("module");
const scripted = [];
let calls = 0;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@anthropic-ai/sdk") {
    return class FakeAnthropic {
      constructor() {
        this.messages = {
          create: async () => {
            const step = scripted[calls++];
            if (!step) throw new Error("stub ran off the end of the script");
            if (step.throw) throw Object.assign(new Error(step.throw.msg || "boom"), step.throw);
            return { content: [{ type: "text", text: step.text }], usage: { input_tokens: 10, output_tokens: 10 } };
          },
        };
      }
    };
  }
  // Keep the controller cases DB-free: /ai-analyze looks up catalogue context
  // before it ever reaches the model.
  if (request === "../services/decorListingContext" || request.endsWith("/decorListingContext")) {
    return { buildListingContext: async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null }) };
  }
  return origLoad.apply(this, arguments);
};

const { analyseImage } = require("../services/decorVision");
const decor = require("../controllers/decor");
const sharp = require("sharp");

// Run a controller handler and capture what it would send.
const post = (handler, body) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ body }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const GOOD = JSON.stringify({
  isDecorProduct: true, category: "Stage", categoryConfidence: 0.9, style: "Modern",
  flowers: [], colors: [], fabric: [], size: { length: 16, width: 12, confidence: 0.6 },
  complexity: { tier: "standard", confidence: 0.6, reasoning: "r" },
  suggestedName: "Ivory Grace", description: "d", tags: ["a"],
});
// Unbalanced quotes inside the free-prose description — the real observed shape.
const BAD = '{"isDecorProduct":true,"description":"It\'s "broken" here';

const run = async (script) => {
  scripted.length = 0; scripted.push(...script); calls = 0;
  try {
    const analysis = await analyseImage({ imageBase64: "X", mode: "full" });
    return { okResult: true, calls, analysis };
  } catch (e) {
    return { okResult: false, calls, code: e.code || e.status, raw: e.raw };
  }
};

(async () => {
  // ── 1. malformed JSON is re-asked, ONCE ───────────────────────────────────
  console.log("1. malformed JSON is retryable, capped at one re-ask");
  let r = await run([{ text: GOOD }]);
  ok(r.okResult && r.calls === 1, "a clean response costs exactly one call");

  r = await run([{ text: BAD }, { text: GOOD }]);
  ok(r.okResult, "one malformed body RECOVERS on the re-ask");
  eq(r.calls, 2, "…having cost two calls");
  eq(r.analysis.suggestedName, "Ivory Grace", "…and returns the second body's analysis");

  r = await run([{ text: BAD }, { text: BAD }]);
  ok(!r.okResult, "two malformed bodies in a row SURFACE rather than looping");
  eq(r.code, "VISION_PARSE", "…as VISION_PARSE, the same error as before this change");
  ok(typeof r.raw === "string" && r.raw.length > 0, "…with .raw kept, so the caller can log what came back");
  eq(r.calls, 2, "…and it stops at the cap, not at the 3-attempt budget");

  r = await run([{ text: BAD }, { text: BAD }, { text: GOOD }]);
  eq(r.calls, 2, "a third attempt is NOT spent on a persistently malformed response");
  ok(!r.okResult, "…so a structural fault is not hidden by a lucky third draw");

  // ── 2. overload retry is unchanged ────────────────────────────────────────
  console.log("\n2. overload retry — unchanged by the parse change");
  r = await run([{ throw: { status: 529 } }, { text: GOOD }]);
  ok(r.okResult && r.calls === 2, "529 overloaded is retried and recovers");
  r = await run([{ throw: { status: 429 } }, { throw: { status: 429 } }, { text: GOOD }]);
  ok(r.okResult && r.calls === 3, "429 twice still recovers on the third attempt");
  r = await run([{ throw: { status: 401, msg: "bad key" } }, { text: GOOD }]);
  ok(!r.okResult && r.calls === 1, "401 auth is NOT retried — a bad key is not transient");
  eq(r.code, 401, "…and the SDK error surfaces unchanged");

  // ── 3. one shared budget ──────────────────────────────────────────────────
  console.log("\n3. parse and overload retries share ONE 3-call budget");
  r = await run([{ throw: { status: 529 } }, { text: BAD }, { text: GOOD }]);
  ok(r.okResult && r.calls === 3, "529 then malformed still gets its third call");
  r = await run([{ throw: { status: 529 } }, { throw: { status: 529 } }, { text: BAD }]);
  ok(!r.okResult && r.calls === 3, "a mix can never exceed three calls");
  eq(r.code, "VISION_PARSE", "…and the LAST failure is what surfaces");

  // ── 4. demo mode gets the same protection ─────────────────────────────────
  console.log("\n4. the live sales panel is covered too");
  scripted.length = 0; scripted.push({ text: BAD }, { text: GOOD }); calls = 0;
  const demo = await analyseImage({ imageBase64: "X", mode: "demo" });
  ok(!!demo && demo.category === "Stage", "demo mode also recovers from a malformed body");
  eq(calls, 2, "…on the same one-re-ask budget");

  // ── 5. END TO END — what the caller actually receives ─────────────────────
  // The cases above prove analyseImage throws VISION_PARSE. These prove what
  // that becomes at the wire: a 502, not a 500, not a hang, not a loop.
  console.log("\n5. a persistent parse failure surfaces as 502 at the endpoints");
  const jpeg = (await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } }).jpeg().toBuffer()).toString("base64");

  scripted.length = 0; scripted.push({ text: BAD }, { text: BAD }); calls = 0;
  let http = await post(decor.AiAnalyze, { imageBase64: jpeg, category: "Stage" });
  eq(http.status, 502, "/decor/ai-analyze returns 502 on a persistent parse failure");
  ok(/unexpected response format/i.test(http.body.message), "…with a client-safe message");
  ok(typeof http.body.raw === "string", "…and the raw body echoed for diagnosis");
  eq(calls, 2, "…after exactly one re-ask, not a loop");

  scripted.length = 0; scripted.push({ text: BAD }, { text: GOOD }); calls = 0;
  http = await post(decor.AiAnalyze, { imageBase64: jpeg, category: "Stage" });
  eq(http.status, 200, "/decor/ai-analyze RECOVERS when the re-ask parses");
  eq(http.body.name, "Ivory Grace", "…returning the second body's listing");
  eq(calls, 2, "…having cost one extra call");

  // The live sales panel. No imageUrl and no pinId, so the read cache is skipped
  // and this stays DB-free — the parse failure returns before any lookup.
  scripted.length = 0; scripted.push({ text: BAD }, { text: BAD }); calls = 0;
  http = await post(decor.DemoPrice, { imageBase64: jpeg });
  eq(http.status, 502, "/decor/demo-price returns 502 on a persistent parse failure");
  ok(/couldn't read this image/i.test(http.body.message), "…with the panel's own wording, not a stack trace");

  scripted.length = 0; scripted.push({ text: BAD }, { text: GOOD }); calls = 0;
  http = await post(decor.DemoPrice, { imageBase64: jpeg });
  // NOT asserting 200 here: past the vision stage this handler queries the
  // catalogue for comparables, which needs a database this suite deliberately
  // does not have. What IS provable — and what this case exists for — is that the
  // re-ask got the request THROUGH vision instead of dying at it.
  ok(http.status !== 502, "/decor/demo-price gets PAST vision on the re-ask (no 502)");
  ok(!/couldn't read this image/i.test(String(http.body && http.body.message)),
    "…so the panel never sees the read-failure wording");
  eq(calls, 2, "…on the same one-re-ask budget");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

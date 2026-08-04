// Phase B — vision layer for the AI Décor Suggester.
//
// One photograph in → one strict-JSON attribute object out. No DB access, no
// writes. The controller (POST /decor/analyse-image) pairs this with the Phase A
// pricing engine (services/decorPricing.js) to attach a band + comparables.
//
// Model: configurable via DECOR_VISION_MODEL, default Sonnet 5. Haiku 4.5
// failed at physical measurement four separate times (complexity ~70% premium,
// size 40x20 in two-thirds of stage reads vs 2% reality, height 15ft on 10ft
// builds, width 24-30ft on an 8-10ft haldi backdrop) while recognition stayed
// excellent — this swap is a controlled single-variable test of measurement.
// scripts/compare-vision-models.js runs the same images through both.
// The SHARED rules go in a cached system block; a small
// mode-specific schema block follows (uncached), so both modes share the same
// cached prefix. Two modes:
//   • demo — returns ONLY isDecorProduct, category, categoryConfidence, size,
//     complexity, style. Fewer output tokens → faster (the < 3s live path).
//   • full — everything, for the draft pipeline.
//
// Accuracy-gate fixes (v2): a rejection escape hatch (isDecorProduct) so cakes/
// portraits/landmarks aren't forced into a category; complexity graded against
// the full budget→celebrity range (not Pinterest) so it stops defaulting to
// "premium"; size anchored to the catalogue's real frequency distribution so it
// stops over-picking 40x20; retry-with-backoff on 429/529.

const Anthropic = require("@anthropic-ai/sdk");
const { readStageMeasurements, OCCASIONS } = require("./decorDemoPrice");

const MODEL = process.env.DECOR_VISION_MODEL || "claude-sonnet-5";

// Model-capability guards — the ONLY request differences between models, both
// forced by the API rather than chosen (everything else in this call is
// identical so the model swap stays a controlled single-variable test):
// - Sonnet 5 / Opus 4.7+ REJECT non-default sampling params (temperature: 0
//   returns a 400); older models keep it.
// - Sonnet 5 runs ADAPTIVE THINKING when `thinking` is omitted, which would
//   spend our small max_tokens on thinking before the JSON — explicitly
//   disabled to match the no-thinking behaviour of the Haiku pipeline.
const NO_SAMPLING_PARAMS = /sonnet-5|opus-5|opus-4-[78]|fable|mythos/;
const THINKING_DEFAULTS_ON = /sonnet-5|opus-5|opus-4-[78]/;

// Category size vocabularies (Playbook Phase B — sizes covering ~92%). Only
// Stage & Mandap truly vary; the rest collapse to their dominant size. Snapping
// to these lists is what keeps sizes out of "multiples of 4" territory.
const SIZE_VOCAB = {
  Stage: [[16, 12], [24, 16], [16, 16], [30, 16], [12, 8], [20, 16], [8, 8], [40, 20], [12, 12]],
  Mandap: [[16, 16], [12, 12], [20, 20], [15, 15], [20, 16]],
  Photobooth: [[8, 8]],
  Pathway: [[8, 8]],
  Nameboard: [[3, 2]],
  Entrance: [[8, 8], [10, 10], [10, 8], [8, 10], [12, 10]],
};

const CATEGORY_LIST = [
  "Stage", "Mandap", "Photobooth", "Entrance", "Pathway", "Nameboard",
  "Mala & More", "Phoolon Ki Chadar", "Partitions", "Furniture",
  "Sound & Light", "Entries & Effects",
];

// ── SHARED rules (CACHED). Identical for both modes — editing it busts the
// cache for both. The mode-specific output schema is a separate block below. ──
const SHARED_RULES = `You are Wedsy's décor vision analyst. Wedsy is a luxury Indian wedding décor company. You are shown ONE photograph and must judge it for the Wedsy décor catalogue.

STEP 0 — IS THIS A DÉCOR PRODUCT? Decide this FIRST and set "isDecorProduct".
Wedsy sells INSTALLED event décor: stages, mandaps, photobooths, entrance arches, pathways, nameboards, garlands, floral canopies, and related props/services.

Judge by what the image is PRIMARILY showing, NOT by whether people are present. Almost every real wedding photo contains people.
- If the image PRIMARILY shows substantial, clearly visible décor (a stage, mandap, arch, backdrop, etc.), set isDecorProduct=TRUE and classify the DÉCOR — even when a couple, guests, dancing, or a live ceremony are in the frame. Describe the décor and ignore the people. A couple standing under a full mandap is a MANDAP — this is the single most common wedding-Pinterest shot, so classify it, do not reject it.
- Set isDecorProduct=false for people ONLY when the image is PRIMARILY a portrait or close-up of a person/couple and the décor is incidental — blurred, cropped out, tiny in the background, or absent. Same principle for guest shots, dancing, and ceremony close-ups: judge the décor, not the humans.

The following are NOT décor products — set isDecorProduct=false and category=null EVEN WHEN FLOWERS ARE PRESENT:
- Wedding cakes or any food/dessert — a flower-topped cake is still a cake.
- Outfits AS THE SUBJECT: a lehenga / saree / suit / jewellery product or fashion close-up with no installed décor behind it. (People WEARING outfits in front of real décor is décor — see the primary-subject rule above.)
- Venues or buildings shown WITHOUT installed décor: empty halls, hotels, exteriors, interiors as bare architecture.
- Famous landmarks or monuments (Taj Mahal, forts, palaces as tourist sites) — never décor.
- Vehicles — a decorated car is still a vehicle.
- Landscapes, gardens, nature scenes with no built installation.
On a borderline BUILT installation, lean true — but the categories above are hard NOs no matter how many flowers appear.

CATEGORY (only when isDecorProduct=true) — pick the single best:
- Stage: main wedding stage / seating backdrop.
- Mandap: 4-pillar canopy structure the couple sits under.
- Photobooth: selfie / photo backdrop.
- Entrance: entry arch or gate.
- Pathway: aisle / walkway décor.
- Nameboard: name or welcome signage.
- Mala & More: garlands.
- Phoolon Ki Chadar: floral canopy carried over the head.
- Partitions / Furniture / Sound & Light / Entries & Effects: props and services.

SIZE — CLASSIFY, DO NOT MEASURE. Snap to the category's real vocabulary; NEVER free-form, NEVER round to a multiple of 4 (the catalogue genuinely uses 30, 15x15, 3x2).
Only Stage and Mandap vary meaningfully. Every other category has a dominant size:
- Photobooth 8x8 · Pathway 8x8 · Nameboard 3x2 · Entrance default 8x8 (go larger — 10x10 / 10x8 / 8x10 / 12x10 — ONLY with clear evidence).
- Mala & More / Phoolon Ki Chadar / Partitions / Furniture / Sound & Light / Entries & Effects: size is not meaningful → {"length":0,"width":0,"confidence":0}.
STAGE — choose ONE and PREFER THE COMMON SIZES. Real catalogue frequency (count of products):
  24x16 (42) · 16x12 (39) · 16x16 (23) · 30x16 (21) · 20x16 (17) · 12x8 (14) · 8x8 (12) · 40x20 (4).
24x16 and 16x12 are the safe defaults when scale is ambiguous. 40x20 is only ~2% of the catalogue: pick it ONLY with visible evidence of a stage spanning a FULL HALL with multiple distinct seating groups. If you are not certain it is a hall-spanning, multi-group stage, choose 24x16 or 30x16 instead. NEVER choose 40x20 just because the stage is tall, grand, or richly decorated.
MANDAP — choose ONE of 16x16, 12x12, 20x20, 15x15, 20x16; 16x16 and 12x12 are the common defaults.
Scale from reference objects: sofa ≈ 6-7 ft wide, chair ≈ 1.5 ft, adult ≈ 5.5 ft, doorway ≈ 7 ft. A backdrop ≈ 2 sofa-widths ≈ 12-16 ft. Set size.confidence honestly — low if there is nothing to scale against.

COMPLEXITY — grade against the FULL RANGE of Indian wedding décor, from budget weddings to celebrity weddings — NOT against other Pinterest images. A typical well-shot Pinterest photo is usually STANDARD or ELABORATE, not premium. Premium is the TOP QUARTILE ONLY: genuinely exceptional scale — a full-hall installation, multiple distinct structures, chandeliers/heavy props, luxury finish. Do NOT default to premium.
Calibrate against the Stage natural-tier price the build would command:
- simple:    under ₹40,000   — minimal flowers, one flat backdrop, little/no lighting.
- standard:  ₹40,000-60,000  — moderate florals, one structural element, some lighting.
- elaborate: ₹60,000-84,000  — dense florals, multiple structures (arch + tiering), rich lighting/drapery.
- premium:   above ₹84,000   — TOP QUARTILE ONLY: full floral coverage, grand multi-structure build, chandeliers, luxury finish.
DECISION PROCEDURE (follow in order, do not skip a step): start at "standard".
- Go DOWN to "simple" only if the build is minimal — a single flat backdrop, sparse/no flowers, no special lighting.
- Go UP to "elaborate" if there are dense florals AND at least one clear structural feature (arch, tiering, layered/3D backdrop, hanging install). MOST lavish, well-decorated Pinterest stages are ELABORATE — a beautiful full-floral backdrop with an arch is elaborate, not premium.
- Go UP to "premium" ONLY if ALL FOUR hold at once: (1) full floral coverage across the entire set, (2) MULTIPLE distinct built structures (e.g. stage PLUS separate arches / pillars / a ceiling installation), (3) chandeliers or heavy props, AND (4) clearly large / full-hall scale. If even ONE is missing, it is at most elaborate. Your reasoning must name which of these four you actually see. A gorgeous single ornate floral arch/backdrop with a chandelier is ELABORATE, not premium — it has one structure, not several.
DISTRIBUTIONAL PRIOR: in the real catalogue only ~15-20% of stages are premium and very few are simple — MOST are standard-to-elaborate, and "elaborate" is the correct default for a pretty, well-decorated Pinterest stage. If you are calling premium on most images, you are over-grading; pull back to elaborate. Do NOT default to premium.
For non-Stage categories apply the same quartile logic within that category's own price range. Give a one-line reasoning naming exactly what you saw, and set complexity.confidence honestly.

STYLE: only "Modern" or "Traditional" (Indian classical / royal). Return null unless confident. Mainly matters for Stage.

Calibrate every confidence honestly.`;

// ── mode-specific output schema (NOT cached; small). ─────────────────────────
const FULL_SCHEMA_INSTR = `Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:
{
  "isDecorProduct": boolean,
  "category": one of ${JSON.stringify(CATEGORY_LIST)} OR null (null when isDecorProduct is false),
  "categoryConfidence": number 0.0-1.0,
  "style": "Modern" | "Traditional" | null,
  "flowers": string[],
  "colors": string[],
  "fabric": string[],
  "size": { "length": number, "width": number, "confidence": number 0.0-1.0 },
  "complexity": { "tier": "simple"|"standard"|"elaborate"|"premium", "confidence": number 0.0-1.0, "reasoning": string },
  "suggestedName": string,
  "description": string,
  "tags": string[],
  "included": string[]
}
If isDecorProduct is false: set category=null, return empty arrays for flowers/colors/fabric/tags/included and empty strings for suggestedName/description; still give best-effort size/complexity/style.`;

// Demo-only: `observations` uses the founder's concrete vocabulary. These are
// OBSERVATIONS the staff member reads to place the quote within the range —
// they are never graded and never touch a price (the Phase 3 measurement gate
// proved they do not predict price). Kept in this uncached block so adding
// them didn't bust the shared cached prefix.
const DEMO_SCHEMA_INSTR = `Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys and NOTHING else:
{
  "isDecorProduct": boolean,
  "category": one of ${JSON.stringify(CATEGORY_LIST)} OR null (null when isDecorProduct is false),
  "categoryConfidence": number 0.0-1.0,
  "style": "Modern" | "Traditional" | null,
  "size": { "length": number, "width": number, "confidence": number 0.0-1.0 },
  "complexity": { "tier": "simple"|"standard"|"elaborate"|"premium", "confidence": number 0.0-1.0, "reasoning": string },
  "observations": string[],
  "minBuildWidth": { "minWidthFt": number, "reasoning": string, "confidence": number 0.0-1.0 },
  "recommendedSize": { "length": number, "width": number } | null,
  "occasion": { "value": one of ${JSON.stringify(OCCASIONS)} OR null, "confidence": number 0.0-1.0 },
  "stageMeasurements": { "backdropWidthFt": number, "floralRunFt": number, "widthToHeightRatio": number, "rawHeightEstimateFt": number, "reasoning": string, "confidence": number 0.0-1.0 } | null
}
"stageMeasurements" — for any backdrop-style installation (stage, backdrop, large photobooth wall); null when there is no backdrop:
- backdropWidthFt: total backdrop width in feet. Count sofas across — a sofa is ~5 ft wide (e.g. "fits five sofas across" ≈ 25 ft).
- floralRunFt: how many of those running feet are GENUINELY a wall of flowers. This is the price driver, and it is NOT the width: garlands, top borders, clusters and scattered arrangements count as a FRACTION of the width they span, never the full width. A 24 ft backdrop with only a top garland and side clusters has roughly 12-13 running feet of true floral. Only a solid floral wall counts foot-for-foot. State your arithmetic in "reasoning".
- HEIGHT = the BUILT STRUCTURE ONLY, measured to the TOP EDGE of the backdrop panels/frames. Founder's rule: "mostly the panel height. Floral could be lower, or floral and panel could be the same height." Measure to the PANEL TOP. Explicitly IGNORE everything above the structure — venue background, trees, sky, ceiling, hanging lights not mounted on the build. Ignore floral spires that shoot above the panel line (still measure to the panel top). Ignore the platform/steps below the structure. NEVER scale the whole photo frame — only the structure itself.
- widthToHeightRatio (the PRIMARY height signal): judge how many times WIDER the backdrop structure is than it is TALL — "about 3x wider than it is tall" → 3.0. Ratios are scale-invariant: no reference object needed, immune to camera angle, framing and lens.
- rawHeightEstimateFt = backdropWidthFt / widthToHeightRatio. As a SANITY CHECK ONLY, also count sofa-heights (~3 ft each) against the structure; if the sofa-derived height disagrees with the ratio-derived height by more than ~40%, LOWER your confidence rather than picking one. State both estimates and the ratio in "reasoning". Do NOT round to a standard size — the server snaps to the real build heights.
Set confidence below 0.5 when nothing in frame gives reliable scale.
"minBuildWidth" — the MINIMUM width in feet this design could physically be built at, scaled from reference objects visible in the photo: sofa ~5 ft wide, chair ~1.5 ft, adult ~5.5 ft tall, doorway ~7 ft tall. Count the objects the installation spans (e.g. "backdrop fits five to six sofas across, so it needs 30 ft") and state that count in "reasoning". This is a physical floor, not a size estimate — a design can be built LARGER than its minimum, never smaller. Set confidence below 0.5 when nothing in frame gives reliable scale.
"recommendedSize" — the single size from the category's vocabulary this design best fits, or null when the category has no meaningful size.
"observations" — 2 to 5 short phrases describing ONLY what is clearly VISIBLE, one per axis, in exactly this vocabulary (skip an axis you cannot judge):
- structure type: "temple-style structure" | "elegant non-square structure" | "regular square structure"
- floral density: "sparse florals" | "moderate florals" | "heavy florals" | "full floral coverage"
- floral workmanship: "traditional stringing / toran / hanging work" | "modern arranged florals"
- fabrication: "stock steel structure" | "custom FRP / fibre work"
- signature props, named plainly when present: e.g. "chandeliers", "canopy", "signage"
These are factual observations, NOT gradings — no quality words, no price implications, no invented detail.
"occasion" — the EVENT this décor is for, judged from DISTINCTIVE visual signals only (e.g. haldi: marigold/yellow-dominated small daytime setup with traditional stringing and hanging work; mehendi: green/rustic garden styling; reception: grand formal stage). Return value null with low confidence when the signals are not distinctive — most decor photos are not attributable to an occasion.
Do NOT include flowers, colors, fabric, suggestedName, description, tags, or included.`;

// ── helpers ──────────────────────────────────────────────────────────────────
const stripJsonFence = (text = "") =>
  String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

const buildImageSource = ({ imageBase64, imageUrl }) => {
  if (imageUrl) return { type: "url", url: imageUrl };
  if (imageBase64) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(imageBase64);
    if (m) return { type: "base64", media_type: m[1], data: m[2] };
    return { type: "base64", media_type: "image/jpeg", data: imageBase64 };
  }
  return null;
};

// Snap a raw estimate to the category's vocabulary by nearest area. Categories
// with a single-entry vocab (Photobooth/Pathway/Nameboard) always resolve to
// their dominant size. Categories with no vocab (flat / garland types) → null.
const snapSize = (category, size) => {
  const vocab = SIZE_VOCAB[category];
  if (!vocab) return null;
  const L = Number(size && size.length);
  const W = Number(size && size.width);
  if (!(L > 0) || !(W > 0)) {
    const [dl, dw] = vocab[0]; // dominant / default
    return { length: dl, width: dw };
  }
  const area = L * W;
  let best = vocab[0];
  let bestD = Infinity;
  vocab.forEach(([vl, vw]) => {
    const d = Math.abs(vl * vw - area);
    if (d < bestD) { bestD = d; best = [vl, vw]; }
  });
  return { length: best[0], width: best[1] };
};

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== "") : []);
const clamp01 = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
};
const asStr = (v) => (typeof v === "string" ? v : "");

// Normalise model output into the documented shape (defensive server-side).
// When isDecorProduct is false, category is null and no included[]/text fields.
const postProcess = (raw = {}, mode = "full") => {
  const isDecorProduct =
    typeof raw.isDecorProduct === "boolean" ? raw.isDecorProduct : Boolean(raw.category);
  const category = isDecorProduct ? raw.category || null : null;

  const rawSize = raw.size || {};
  const snapped = snapSize(category, rawSize);
  const size = snapped
    ? { length: snapped.length, width: snapped.width, confidence: clamp01(rawSize.confidence) }
    : { length: 0, width: 0, confidence: 0 };

  const cx = raw.complexity || {};
  const tier = ["simple", "standard", "elaborate", "premium"].includes(cx.tier)
    ? cx.tier
    : "standard";
  const complexity = {
    tier,
    confidence: clamp01(cx.confidence),
    reasoning: asStr(cx.reasoning),
  };

  const style = raw.style === "Modern" || raw.style === "Traditional" ? raw.style : null;

  const base = {
    isDecorProduct,
    category,
    categoryConfidence: clamp01(raw.categoryConfidence),
    style,
    size,
    complexity,
  };
  if (mode === "demo") {
    // Founder-vocabulary observations (demo only) — descriptive strings, capped
    // so a runaway list can't bloat the panel. Empty for non-décor images.
    const observations = isDecorProduct
      ? asArray(raw.observations).filter((o) => typeof o === "string").slice(0, 6)
      : [];

    // Minimum buildable width, scaled from reference objects in the photo. The
    // panel hides size rows below it (only when confidence is decent — that
    // gate lives client-side so staff can tune it without a deploy).
    const mbw = raw.minBuildWidth || {};
    const minWidthFt = Number(mbw.minWidthFt);
    const minBuildWidth =
      isDecorProduct && Number.isFinite(minWidthFt) && minWidthFt > 0
        ? { minWidthFt, reasoning: asStr(mbw.reasoning), confidence: clamp01(mbw.confidence) }
        : null;

    // Best-fit size, snapped to the category vocabulary — only when the model
    // actually returned one (snapSize would otherwise fabricate the default).
    let recommendedSize = null;
    const rs = raw.recommendedSize;
    if (isDecorProduct && rs && Number(rs.length) > 0 && Number(rs.width) > 0) {
      const snapped = snapSize(category, rs);
      if (snapped) recommendedSize = `${snapped.length}x${snapped.width}`;
    }

    // Backdrop measurements (drive Stage floral-run pricing). Shared validator:
    // caps floral run at backdrop width and resolves the raw height through the
    // 10/12/15 build-height model (snap + width prior + confidence gates).
    const stageMeasurements = isDecorProduct ? readStageMeasurements(raw.stageMeasurements) : null;

    // Detected occasion — vocabulary-gated; anything off-list becomes null.
    const rawOcc = raw.occasion || {};
    const occasion = {
      value: isDecorProduct && OCCASIONS.includes(rawOcc.value) ? rawOcc.value : null,
      confidence: clamp01(rawOcc.confidence),
    };

    return { ...base, observations, minBuildWidth, recommendedSize, stageMeasurements, occasion };
  }

  return {
    ...base,
    flowers: asArray(raw.flowers),
    colors: asArray(raw.colors),
    fabric: asArray(raw.fabric),
    suggestedName: isDecorProduct ? asStr(raw.suggestedName) : "",
    description: isDecorProduct ? asStr(raw.description) : "",
    tags: isDecorProduct ? asArray(raw.tags) : [],
    included: isDecorProduct ? asArray(raw.included) : [], // no included[] for non-décor
  };
};

// Retry the model call on transient overload (429 rate limit / 529 overloaded).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 529]);
const isRetryable = (e) =>
  RETRYABLE.has(e && e.status) ||
  (e && e.error && e.error.type === "overloaded_error") ||
  e?.name === "APIConnectionError";
const createWithRetry = async (client, params, attempts = 3) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1 && isRetryable(e)) {
        await sleep(500 * Math.pow(2, i)); // 500ms, 1000ms
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
};

// analyseImage({ imageBase64?, imageUrl?, mode? }) → normalized analysis object.
//   mode: 'demo' (default fields only, faster) | 'full' (everything).
// Throws: err.code "NO_IMAGE" (bad input), "VISION_PARSE" (non-JSON — err.raw),
// or the raw Anthropic SDK error (auth/rate/etc., after retries).
const analyseImage = async ({ imageBase64, imageUrl, mode } = {}) => {
  const source = buildImageSource({ imageBase64, imageUrl });
  if (!source) {
    const err = new Error("image (base64) or imageUrl is required");
    err.code = "NO_IMAGE";
    throw err;
  }
  const useMode = mode === "demo" ? "demo" : "full";

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await createWithRetry(client, {
    model: MODEL,
    max_tokens: useMode === "demo" ? 896 : 1024, // demo carries observations + min-width + stage-measurement reasoning
    // See the model-capability guards above — API-forced, not tuning.
    ...(NO_SAMPLING_PARAMS.test(MODEL) ? {} : { temperature: 0 }),
    ...(THINKING_DEFAULTS_ON.test(MODEL) ? { thinking: { type: "disabled" } } : {}),
    system: [
      { type: "text", text: SHARED_RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: useMode === "demo" ? DEMO_SCHEMA_INSTR : FULL_SCHEMA_INSTR },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source },
          { type: "text", text: "Analyse this image. Return only the JSON object." },
        ],
      },
    ],
  });

  const text = (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch (e) {
    const err = new Error("Vision model returned non-JSON output");
    err.code = "VISION_PARSE";
    err.raw = text;
    throw err;
  }
  return postProcess(parsed, useMode);
};

module.exports = {
  analyseImage,
  postProcess, // exported for the offline test harness / unit checks
  snapSize,
  SIZE_VOCAB,
  MODEL,
};

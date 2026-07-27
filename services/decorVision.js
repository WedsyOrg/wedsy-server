// Phase B — vision layer for the AI Décor Suggester.
//
// One photograph in → one strict-JSON attribute object out. No DB access, no
// writes. The controller (POST /decor/analyse-image) pairs this with the Phase A
// pricing engine (services/decorPricing.js) to attach a band + comparables.
//
// Model: Haiku 4.5 (cheap, fast — the demo needs < 3s). The static rules below
// are sent as a cached system block so repeated calls bill the prompt at 0.1×.
//
// Size is CLASSIFIED, never measured: the model picks from each category's real
// vocabulary and we snap defensively server-side. We never round to a multiple
// of 4 — the catalog uses 30, 15×15, 3×2, etc. Complexity is the price-placing
// signal the backtest proved was missing (same-size stages differ up to 6×).

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = process.env.DECOR_VISION_MODEL || "claude-haiku-4-5-20251001";

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

// ── Static rules (CACHED). Keep this stable — editing it busts the cache. ─────
const STATIC_RULES = `You are Wedsy's décor vision analyst. Wedsy is a luxury Indian wedding décor company. You are shown ONE photograph of wedding/event décor and you return a SINGLE JSON object describing it.

Return ONLY the JSON object. No prose, no explanation, no markdown code fences.

SCHEMA (all keys required):
{
  "category": one of ${JSON.stringify(CATEGORY_LIST)},
  "categoryConfidence": number 0.0-1.0,
  "style": "Modern" | "Traditional" | null,
  "flowers": string[],            // e.g. "artificial","natural","roses","orchids","marigold"; [] if none/unsure
  "colors": string[],             // dominant colours, lowercase
  "fabric": string[],             // visible drape/backdrop fabrics; [] otherwise
  "size": { "length": number, "width": number, "confidence": number 0.0-1.0 },
  "complexity": { "tier": "simple"|"standard"|"elaborate"|"premium", "confidence": number 0.0-1.0, "reasoning": string },
  "suggestedName": string,        // 2 words, premium Indian-wedding catalogue feel
  "description": string,          // 2-3 sentences, emotional luxury language
  "tags": string[],               // 8-12 lowercase search tags
  "included": string[]            // what a Wedsy build of this piece would include
}

CATEGORY — pick the single best:
- Stage: main wedding stage / seating backdrop.
- Mandap: 4-pillar canopy structure the couple sits under.
- Photobooth: selfie / photo backdrop.
- Entrance: entry arch or gate.
- Pathway: aisle / walkway décor.
- Nameboard: name or welcome signage.
- Mala & More: garlands.
- Phoolon Ki Chadar: floral canopy carried over the head.
- Partitions / Furniture / Sound & Light / Entries & Effects: props and services.

SIZE — CLASSIFY, DO NOT MEASURE. Snap to the category's known vocabulary. NEVER output a free-form number and NEVER round to a multiple of 4 (the catalogue genuinely uses 30, 15×15, 3×2).
- Stage: choose EXACTLY ONE (length×width ft): 16x12, 24x16, 16x16, 30x16, 12x8, 20x16, 8x8, 40x20, 12x12.
- Mandap: choose EXACTLY ONE: 16x16, 12x12, 20x20, 15x15, 20x16.
- Photobooth: always 8x8. Pathway: always 8x8. Nameboard: always 3x2.
- Entrance: default 8x8 unless clearly larger; then pick from 10x10, 10x8, 8x10, 12x10.
- Mala & More, Phoolon Ki Chadar, Partitions, Furniture, Sound & Light, Entries & Effects: size is not meaningful — return {"length":0,"width":0,"confidence":0}.
Estimate scale from reference objects in the photo: a grand sofa ≈ 6-7 ft wide, a chair ≈ 1.5 ft, an adult ≈ 5.5 ft tall, a doorway ≈ 7 ft tall. A backdrop ≈ 2 sofa-widths ≈ 12-16 ft; ≈ 4 sofas across ≈ 24-30 ft. Set size.confidence honestly — if there is no reference object to scale from, lower it.

COMPLEXITY — the most important field for pricing. Two same-size stages can differ up to 6× in price on build complexity alone. Judge: flower density & coverage (sparse accents → full floral walls), structure (flat backdrop → arches, domes, multi-tier, layered/3D backdrops, hanging installs), lighting & props (none → chandeliers, LED, drapery, candles, fire/water features), and finish quality. Map to a tier:
- simple: minimal flowers, one flat backdrop, little/no lighting → bottom of the band.
- standard: moderate florals, one structural element, some lighting → middle of the band.
- elaborate: dense florals, multiple structures (e.g. arch + tiering), rich lighting/drapery → upper band.
- premium: full floral coverage, grand multi-structure build, chandeliers/heavy props, luxury finish → top of the band.
Give a one-line reasoning naming exactly what you saw, and set complexity.confidence honestly.

STYLE: only "Modern" or "Traditional" (Indian classical / royal). Return null unless you are confident. Style mainly matters for Stage.

Be decisive but calibrate every confidence honestly. Return ONLY the JSON object.`;

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

// Normalise the model output into the documented shape (defensive server-side).
const postProcess = (raw = {}) => {
  const category = raw.category;
  const rawSize = raw.size || {};
  const snapped = snapSize(category, rawSize);
  const size = snapped
    ? { length: snapped.length, width: snapped.width, confidence: clamp01(rawSize.confidence) }
    : { length: 0, width: 0, confidence: 0 };

  const cx = raw.complexity || {};
  const tier = ["simple", "standard", "elaborate", "premium"].includes(cx.tier)
    ? cx.tier
    : "standard";

  const style = raw.style === "Modern" || raw.style === "Traditional" ? raw.style : null;

  return {
    category,
    categoryConfidence: clamp01(raw.categoryConfidence),
    style,
    flowers: asArray(raw.flowers),
    colors: asArray(raw.colors),
    fabric: asArray(raw.fabric),
    size,
    complexity: {
      tier,
      confidence: clamp01(cx.confidence),
      reasoning: typeof cx.reasoning === "string" ? cx.reasoning : "",
    },
    suggestedName: typeof raw.suggestedName === "string" ? raw.suggestedName : "",
    description: typeof raw.description === "string" ? raw.description : "",
    tags: asArray(raw.tags),
    included: asArray(raw.included),
  };
};

// analyseImage({ imageBase64?, imageUrl? }) → normalized analysis object.
// Throws: err.code "NO_IMAGE" (bad input), "VISION_PARSE" (model returned
// non-JSON — carries err.raw), or the raw Anthropic SDK error (auth/rate/etc.).
const analyseImage = async ({ imageBase64, imageUrl } = {}) => {
  const source = buildImageSource({ imageBase64, imageUrl });
  if (!source) {
    const err = new Error("image (base64) or imageUrl is required");
    err.code = "NO_IMAGE";
    throw err;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: [{ type: "text", text: STATIC_RULES, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source },
          { type: "text", text: "Analyse this décor image. Return only the JSON object." },
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
  return postProcess(parsed);
};

module.exports = {
  analyseImage,
  postProcess, // exported for the offline test harness / unit checks
  snapSize,
  SIZE_VOCAB,
  MODEL,
};

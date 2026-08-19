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
//
// THE MERGE (2026-08-19). FULL mode now writes the catalogue listing as well as
// making the pricing judgement — one image, one call. The separate listing brain
// (services/decorListing.js + AI_SYSTEM_PROMPT) is DELETED; A2S and
// POST /decor/ai-analyze both route here.
//
// HISTORY, because this was refused twice and the reasoning should not be lost:
// asking for catalogue copy in the same call DESTABILISES THE STYLE READ. Probed
// on st034 "Sage Elegance", same image, 8 reads per arm, identical SHARED_RULES:
//     pricing-only schema : Traditional 8/8 · Modern 0/8   (deterministic)
//     schema with copy    : Traditional 3/8 · Modern 5/8   (a coin flip)
// That was blocking because `style` fed decorPricing.STYLE_PREMIUM, worth ±42%
// on a Stage price. It no longer does: as of 2026-08-19 NO pricing path passes
// style into suggestPrice (verified across the panel's sizeOptions and ladder,
// the anchor lookup fallback, A2S aiSuggested, and the real /analyse-image
// controller — all byte-identical across Modern/Traditional/null). The residual
// cost of a style wobble is a wrong LABEL on a product, not a wrong price.
//
// ⚠️ SO THE ONE THING THAT WOULD RE-ARM THIS is re-wiring style as a price input.
// If that ever happens, this block has to be split again — see the note on
// STYLE_PREMIUM in services/decorPricing.js.
//
// Category and size were UNAFFECTED by the copy fields in that same gate
// (category 91.7% both arms, size exact-match 41.7% both arms), which is why the
// re-run bar is "no worse on category and size".
const FULL_SCHEMA_INSTR = `Make the judgement above, then write this product's catalogue listing.

NAME — two words preferred; three is fine when it genuinely reads better.
- Luxury Indian wedding register: premium, and specific to this build.
- A traditional-looking build gets a royal / classic / cultural name — Ivory Grace, Regal Flora, Marigold Grandeur. A modern-looking one gets a sleek / premium name — Velvet Aura, Opal Pavilion, Celestial Bloom.
- When the user message supplies existing_names, the name must not resemble any of them.
- No colour-only names, no generic names, nothing that reads like a local vendor.

DESCRIPTION — 2 to 5 sentences, luxury emotional language. Write to how the setup feels to walk into, not to a specification. This voice is deliberate.

TAGS — 8 to 12 tags, one or two words each, all lowercase. Invent these freely; they are NOT restricted to any supplied list. Between them cover: style, colour, occasion, structure, mood, and material where it is visible.

COLOURS, FLOWERS, FABRIC — when the user message supplies attribute_options, "colors", "flowers" and "fabric" must be drawn ONLY from the matching list there. Never invent a value; return [] when unsure. Without attribute_options, describe them freely.

Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:
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
  "tags": string[]
}
"style" is the single style judgement made above — decide it once, from the build, and do not revisit it while writing the copy. There is no second style field and no three-way aesthetic: only "Modern" or "Traditional", or null when you are not confident.
Do NOT return occasions, seoKeywords, detectedAesthetic or included. The occasion is judged elsewhere, and what a product includes is a business rule applied server-side from the category.
If isDecorProduct is false: set category=null, return empty arrays for flowers/colors/fabric/tags and empty strings for suggestedName/description; still give best-effort size/complexity/style.`;


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
  "stageMeasurements": { "sceneType": string, "repeatingElements": { "count": number, "type": string, "estimatedWidthEachFt": number }, "spanWidthFt": number, "backdropWidthFt": number, "structureGeometry": "blocky" | "curved_ornate", "floralRunFt": number, "widthToHeightRatio": number, "rawHeightEstimateFt": number, "reasoning": string, "confidence": number 0.0-1.0 } | null
}
"stageMeasurements" — for any backdrop-style installation (stage, backdrop, large photobooth wall); null when there is no backdrop.
WIDTH IS COUNTED, NOT EYEBALLED. Counting discrete units is reliable; judging a continuous span in feet is not — it has been wrong by +60% on small builds and -55% on large ones. Work through these three in order:
- sceneType — classify THE SHOT, not the build. One of: "closeup_single_element" | "stage_fills_frame" | "wide_venue_shot" | "full_venue_with_grounds".
  · closeup_single_element — one element (a single panel, one arch, a sofa vignette) fills the frame; no venue context at all.
  · stage_fills_frame — the whole installation fills the frame edge to edge with little venue around it; typically one seating group in front.
  · wide_venue_shot — the installation PLUS clear venue context: multiple seating clusters, an aisle, side walls, ceiling.
  · full_venue_with_grounds — lawn, walkways, distant guests, the whole venue or its grounds in frame.
  This is a scene choice, not a measurement: pick it from what is in frame and do NOT adjust it to agree with your width. A genuinely 50-60 ft build CANNOT be photographed close — it forces a wide or full-venue shot. A 10-12 ft haldi backdrop fills the frame with one sofa in front.
- repeatingElements — the repeating ARCHITECTURAL UNIT the backdrop is built from: panels, bays, arches, columns, pillars, drapes.
  · count: how many of those units span the backdrop. COUNT THEM, including partly-occluded ones at the edges. This is the reliable half of the estimate — spend your effort here.
  · type: what the unit is — "panels", "bays", "arches", "columns", "pillars".
  · estimatedWidthEachFt: the width of ONE unit. Judge it against a reference standing at THE SAME DEPTH as that unit — a chair on the stage, a person beside the panel, a doorway in the same plane. NEVER scale a foreground object against a distant backdrop: the foreground object is nearer and reads far larger in frame, and that is exactly what makes wide shots come out too small. If nothing sits at that depth, reason from the build: a full-height decorative panel is rarely under 4 ft or over 12 ft, and a structural bay of a large multi-bay facade is typically 8-12 ft.
  If there is genuinely no repeating unit (one continuous floral wall), set count=1 and estimatedWidthEachFt to the whole width.
- spanWidthFt: your whole-span impression in feet — how wide the backdrop simply LOOKS. Count sofas across if that helps (a sofa is ~5 ft wide). This is a CROSS-CHECK ONLY and does not set the answer.
- backdropWidthFt = count × estimatedWidthEachFt. COMPUTE it from the two numbers above; do not re-guess it and do not reconcile it with spanWidthFt. If the three signals disagree — say a full_venue_with_grounds shot whose units multiply out to 24 ft — LEAVE THEM DISAGREEING and name the disagreement in "reasoning". Never split the difference: an averaged number is wrong in a new way and hides that anything was wrong.
- structureGeometry: "blocky" | "curved_ornate" — judge the SHAPE of the built surfaces, NOT what they are made of. Do not try to identify the material; you cannot reliably tell FRP from MDF from plywood by looking at a surface, and you do not need to.
  · "blocky" — flat, straight-edged, rectilinear panel work: a wall of square or rectangular panels, straight frames, flat printed backdrops, plain draped screens. Corners are square and surfaces are flat.
  · "curved_ornate" — anything rounded, wavy, moulded, carved, scalloped, domed, arched with a shaped profile, or otherwise uneven in its built surface. Curves in the STRUCTURE itself, not curves in the florals draped on it.
  Ask only "are the built surfaces flat and square, or shaped and uneven?" and answer that. Default to "blocky" when the build is plainly rectilinear or you cannot tell.
- floralRunFt: how many of those running feet are GENUINELY a wall of flowers. This is the price driver, and it is NOT the width: garlands, top borders, clusters and scattered arrangements count as a FRACTION of the width they span, never the full width. A 24 ft backdrop with only a top garland and side clusters has roughly 12-13 running feet of true floral. Only a solid floral wall counts foot-for-foot. State your arithmetic in "reasoning".
- HEIGHT = the BUILT STRUCTURE ONLY, measured to the TOP EDGE of the backdrop panels/frames. Founder's rule: "mostly the panel height. Floral could be lower, or floral and panel could be the same height." Measure to the PANEL TOP. Explicitly IGNORE everything above the structure — venue background, trees, sky, ceiling, hanging lights not mounted on the build. Ignore floral spires that shoot above the panel line (still measure to the panel top). Ignore the platform/steps below the structure. NEVER scale the whole photo frame — only the structure itself.
- widthToHeightRatio (the PRIMARY height signal): judge how many times WIDER the backdrop structure is than it is TALL — "about 3x wider than it is tall" → 3.0. Ratios are scale-invariant: no reference object needed, immune to camera angle, framing and lens.
- rawHeightEstimateFt = spanWidthFt / widthToHeightRatio. Use the SPAN here, not the counted backdropWidthFt — the height read is accurate as it stands and the width rebuild must not disturb it. As a SANITY CHECK ONLY, also count sofa-heights (~3 ft each) against the structure; if the sofa-derived height disagrees with the ratio-derived height by more than ~40%, LOWER your confidence rather than picking one. State both estimates and the ratio in "reasoning". Do NOT round to a standard size — the server snaps to the real build heights.
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

// `included` is a business rule, not a judgement call — derived from the
// category server-side. (Absorbed from services/decorListing.js when the two
// brains merged; POST /decor/ai-analyze has always applied exactly this.)
const includedFor = (category) => {
  const cat = String(category || "").toLowerCase();
  const seaterCategories = ["stage", "mandap"];
  // ⚠️ FIXED 2026-08-19: this list said "entrance arch", but the real catalogue
  // category is "Entrance" — so the match never fired and entrance arches
  // shipped with NO lights while Nameboards got them. Matched to the real
  // category name. Keep these strings equal to live category names.
  const ledCategories = ["stage", "mandap", "photobooth", "pathway", "nameboard", "entrance"];
  const included = ["Decor as shown in image", "Props as shown in image"];
  if (ledCategories.some((c) => cat.includes(c))) included.unshift("LED PAR Cans included");
  if (seaterCategories.some((c) => cat.includes(c))) included.unshift("Seaters included");
  return included;
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

  // FULL mode (2026-08-19: now also the listing mode). `included` is DERIVED
  // from the category server-side and never asked of the model — it is a
  // business rule, not a judgement. `suggestedName` keeps its key because
  // /decor/analyse-image already echoes it; /ai-analyze maps it to `name`.
  return {
    ...base,
    flowers: asArray(raw.flowers),
    colors: asArray(raw.colors),
    fabric: asArray(raw.fabric),
    suggestedName: isDecorProduct ? asStr(raw.suggestedName) : "",
    description: isDecorProduct ? asStr(raw.description) : "",
    tags: isDecorProduct ? asArray(raw.tags) : [],
    included: isDecorProduct ? includedFor(category) : [],
  };
};

// Retry the model call on transient overload (429 rate limit / 529 overloaded)
// AND on a malformed JSON body — see PARSE_RETRY_LIMIT below.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 529]);
const isRetryable = (e) =>
  RETRYABLE.has(e && e.status) ||
  (e && e.error && e.error.type === "overloaded_error") ||
  e?.name === "APIConnectionError";

// ── MALFORMED JSON IS RETRYABLE, ONCE (2026-08-19) ──────────────────────────
// The model occasionally returns a body that is not valid JSON — observed once
// in 42 merged calls, inside the free-prose `description`, at stop_reason
// "end_turn" with output nowhere near the token cap. It is not truncation and it
// is not reproducible: 6 further calls on the same image and prompt all parsed.
//
// It is retried because of what it COSTS, not how often it happens: on an A2S
// cache miss a parse failure loses the entire draft — the pricing work, the copy
// and the human's click — and a re-ask is one cheap call against that.
//
// CAPPED AT ONE RE-ASK. A second malformed body in a row is not a bad sample, it
// is something structural (a prompt change, a model change, an image that reliably
// derails the copy), and looping on it would burn tokens and latency while hiding
// the real fault. After the cap the original VISION_PARSE error is thrown with
// `.raw` intact, exactly as before this change — every caller's failure handling
// is unchanged.
//
// Parse retries share the SAME 3-attempt budget and the same 500ms/1000ms
// backoff as overload retries, so a mix of the two can never exceed three calls.
const PARSE_RETRY_LIMIT = Number(process.env.DECOR_VISION_PARSE_RETRIES) || 1;

// createWithRetry(client, params, { attempts, parse })
//   without `parse` → resolves to the raw SDK message (unchanged behaviour)
//   with `parse`    → runs it INSIDE the retry loop and resolves to
//                     { message, parsed }. The parse must throw to signal a bad
//                     body; that throw is what makes a re-ask possible at all,
//                     since the parse used to happen after the loop had returned.
const createWithRetry = async (client, params, { attempts = 3, parse } = {}) => {
  let lastErr;
  let parseFailures = 0;
  for (let i = 0; i < attempts; i++) {
    let message;
    try {
      message = await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1 && isRetryable(e)) {
        await sleep(500 * Math.pow(2, i)); // 500ms, 1000ms
        continue;
      }
      throw e;
    }

    if (!parse) return message;

    try {
      return { message, parsed: parse(message) };
    } catch (parseErr) {
      lastErr = parseErr;
      parseFailures += 1;
      if (i < attempts - 1 && parseFailures <= PARSE_RETRY_LIMIT) {
        console.warn(
          `[decorVision] malformed JSON from the model (attempt ${i + 1}/${attempts}) — re-asking`
        );
        await sleep(500 * Math.pow(2, i));
        continue;
      }
      throw parseErr; // .code "VISION_PARSE", .raw intact
    }
  }
  throw lastErr;
};

// analyseImage({ imageBase64?, imageUrl?, mode? }) → normalized analysis object.
//   mode: 'demo' (default fields only, faster) | 'full' (everything).
// Throws: err.code "NO_IMAGE" (bad input), "VISION_PARSE" (non-JSON — err.raw),
// or the raw Anthropic SDK error (auth/rate/etc., after retries).
const analyseImage = async ({ imageBase64, imageUrl, mode, listingContext } = {}) => {
  const source = buildImageSource({ imageBase64, imageUrl });
  if (!source) {
    const err = new Error("image (base64) or imageUrl is required");
    err.code = "NO_IMAGE";
    throw err;
  }
  // TWO modes. "demo" is the live sales panel and is UNCHANGED — its schema and
  // its cached SHARED_RULES prefix are byte-identical to before the merge, and
  // its reads are cached per pin. "full" is the merged pricing+listing brain.
  const useMode = mode === "demo" ? "demo" : "full";

  // FULL mode only: the naming/attribute context the absorbed listing brain
  // received in ITS user message. Kept in the USER turn — never in a system
  // block — so the cached SHARED_RULES prefix is untouched and demo is unaffected.
  // existing_names is what makes the don't-repeat-a-name rule mean anything; the
  // rule is inert without it.
  let contextText = "";
  if (useMode === "full" && listingContext) {
    const names = asArray(listingContext.existingNames);
    const opts = listingContext.attributeOptions;
    const parts = [];
    if (names.length) {
      parts.push(`existing_names (the "name" you return must NOT be similar to any of these):\n${JSON.stringify(names)}`);
    }
    if (opts && typeof opts === "object" && Object.keys(opts).length) {
      parts.push(`attribute_options (use ONLY these values for the matching fields; return [] if unsure):\n${JSON.stringify(opts)}`);
    }
    if (parts.length) contextText = `\n\n${parts.join("\n\n")}`;
  }

  // The body is parsed INSIDE the retry loop (see createWithRetry) so a malformed
  // JSON response can be re-asked rather than losing the whole call.
  const parseBody = (message) => {
    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    try {
      return JSON.parse(stripJsonFence(text));
    } catch (e) {
      const err = new Error("Vision model returned non-JSON output");
      err.code = "VISION_PARSE";
      err.raw = text;
      throw err;
    }
  };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { message, parsed } = await createWithRetry(client, {
    model: MODEL,
    max_tokens: useMode === "demo" ? 1024 : 1024, // demo carries observations + min-width + the three-part width working
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
          { type: "text", text: `Analyse this image. Return only the JSON object.${contextText}` },
        ],
      },
    ],
  }, { parse: parseBody });

  const out = postProcess(parsed, useMode);
  // Token accounting on FULL only. Demo returns exactly what it always did —
  // its output is what the pin cache stores, and a usage blob would be recorded
  // into every cached read for no reason.
  if (useMode === "demo") return out;
  const u = (message && message.usage) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    ...out,
    _usage: {
      model: MODEL,
      mode: useMode,
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheCreationInputTokens: n(u.cache_creation_input_tokens),
      cacheReadInputTokens: n(u.cache_read_input_tokens),
    },
  };
};

module.exports = {
  analyseImage,
  postProcess, // exported for the offline test harness / unit checks
  includedFor,
  snapSize,
  SIZE_VOCAB,
  FULL_SCHEMA_INSTR,    // exported so the verification gate tests the REAL artefact
  MODEL,
};

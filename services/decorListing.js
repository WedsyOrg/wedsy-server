const Anthropic = require("@anthropic-ai/sdk");
const Decor = require("../models/Decor");
const Attribute = require("../models/Attribute");

// ── Brain 1 of 2: LISTING COPY ───────────────────────────────────────────────
// The same analysis POST /decor/ai-analyze performs (name / description / tags /
// style / colors / flowers / occasions / seoKeywords), callable from the A2S
// draft-create path instead of over HTTP.
//
// It is deliberately NOT fused with the vision+pricing brain (services/
// decorVision + decorPricing): different calibration, different failure modes,
// and the pricing path is pinned by 372 tests. One image, two analyses.
//
// The system prompt is imported from the controller at CALL time (not module
// load) so the two can never drift apart, and so requiring this service never
// creates a load-order cycle with controllers/decor.js.

const stripJsonFence = (text = "") =>
  String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

// Mirrors the post-parse rule in controllers/decor.js AiAnalyze: `included` is
// derived from the category server-side, never left to the model.
const includedFor = (category) => {
  const cat = String(category || "").toLowerCase();
  const seaterCategories = ["stage", "mandap"];
  const ledCategories = ["stage", "mandap", "photobooth", "pathway", "nameboard", "entrance arch"];
  const included = ["Decor as shown in image", "Props as shown in image"];
  if (ledCategories.some((c) => cat.includes(c))) included.unshift("LED PAR Cans included");
  if (seaterCategories.some((c) => cat.includes(c))) included.unshift("Seaters included");
  return included;
};

// Returns the FULL parsed listing object (untrimmed). Throws on API/parse
// failure so the caller decides the failure policy.
const analyseListing = async ({ imageBase64, category }) => {
  if (!imageBase64) throw new Error("analyseListing: imageBase64 is required");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const { AI_SYSTEM_PROMPT } = require("../controllers/decor");

  const [existing, attrs] = await Promise.all([
    category ? Decor.find({ category }, "name").lean() : Promise.resolve([]),
    Attribute.find({}, "name list").lean(),
  ]);
  const existingNames = existing.map((d) => d.name).filter(Boolean);
  const attributeOptions = {};
  attrs.forEach((a) => {
    attributeOptions[a.name] = a.list || [];
  });

  const userText = `Category: ${category || ""}

existing_names (avoid similarity):
${JSON.stringify(existingNames)}

attribute_options (use ONLY these values for the matching fields; return [] if unsure):
${JSON.stringify(attributeOptions)}`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: AI_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
          { type: "text", text: userText },
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
    const err = new Error("AI returned an unexpected response format");
    err.code = "LISTING_PARSE";
    err.raw = text;
    throw err;
  }

  parsed.included = includedFor(category);
  return parsed;
};

module.exports = { analyseListing, includedFor };

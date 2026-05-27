const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk").Anthropic || require("@anthropic-ai/sdk");
const Venue = require("../models/Venue");

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Generate a 2-3 sentence neighbourhood blurb for the venue. Persists to
// venue.locationDescription and short-circuits on subsequent calls so we don't
// burn tokens on every page view — getServerSideProps calls this lazily when
// the field is empty.
const generateLocationDescription = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("name address location locationDescription").lean();
    if (!venue) {
      return res.status(404).json({ error: "Venue not found" });
    }

    // Already generated — return cached value.
    if (venue.locationDescription && venue.locationDescription.trim().length > 0) {
      return res.status(200).json({ locationDescription: venue.locationDescription, cached: true });
    }

    const coords = Array.isArray(venue.location?.coordinates) ? venue.location.coordinates : null;
    const coordsLine = coords && coords.length === 2
      ? `Coordinates: ${coords[1]}, ${coords[0]} (lat, lng).`
      : "Coordinates: unknown.";

    const userPrompt = [
      `Write 2-3 warm, informative sentences about the location of ${venue.name} at ${venue.address || "Bangalore"}, Bangalore.`,
      "Mention what's nearby (areas, landmarks, highway proximity if relevant).",
      "Tone: helpful, for wedding couples. No marketing fluff.",
      "",
      coordsLine,
      "Return only the paragraph — no preamble, no headings, no quotation marks.",
    ].join("\n");

    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = (response?.content || []).find((b) => b.type === "text");
    const description = (textBlock?.text || "").trim();
    if (!description) {
      return res.status(502).json({ error: "Empty response from model" });
    }

    await Venue.updateOne({ slug }, { $set: { locationDescription: description } });
    return res.status(200).json({ locationDescription: description, cached: false });
  } catch (err) {
    console.error("[venueLocation] generate failed:", err.message);
    return res.status(500).json({ error: "Failed to generate location description" });
  }
};

module.exports = { generateLocationDescription };

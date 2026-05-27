require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const Anthropic =
  require("@anthropic-ai/sdk").default ||
  require("@anthropic-ai/sdk").Anthropic ||
  require("@anthropic-ai/sdk");

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("No MONGODB_ATLAS_URL or DATABASE_URL set");
  process.exit(1);
}

(async () => {
  await mongoose.connect(URI);

  const query = {
    $and: [
      {
        $or: [
          { locationDescription: { $exists: false } },
          { locationDescription: "" },
          { locationDescription: null },
        ],
      },
      { "location.coordinates": { $exists: true, $type: "array" } },
      { "location.coordinates.0": { $exists: true } },
    ],
  };

  const venues = await Venue.find(query)
    .select("_id slug name address location locationDescription")
    .lean();

  const total = venues.length;
  console.log(`[script] Found ${total} candidate venue(s) to backfill.`);

  let updated = 0;
  let errors = 0;
  const failedSlugs = [];

  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];
    const slug = venue.slug || String(venue._id);
    console.log(`[${i + 1}/${total}] processing ${slug}`);

    try {
      const prompt = `Write 2-3 warm, informative sentences about the location of ${venue.name} at ${venue.address || "Bangalore"}, Bangalore. Mention what's nearby (areas, landmarks, accessibility, highway proximity if relevant). Tone: helpful and warm, written for wedding couples planning their big day. No marketing fluff. No hashtags.`;

      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content || [])
        .find((b) => b.type === "text")
        ?.text?.trim();

      if (!text) {
        console.error(`[script] ${slug}: empty response from model`);
        errors++;
        failedSlugs.push(slug);
      } else {
        await Venue.updateOne(
          { _id: venue._id },
          { $set: { locationDescription: text } }
        );
        updated++;
      }
    } catch (err) {
      console.error(`[script] ${slug}: ${err.message}`);
      errors++;
      failedSlugs.push(slug);
    }

    await sleep(500);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Candidates found: ${total}`);
  console.log(`Successfully updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  if (failedSlugs.length > 0) {
    console.log("Failed slugs:");
    failedSlugs.forEach((s) => console.log(`  - ${s}`));
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("Failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

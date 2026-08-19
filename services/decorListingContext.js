const Decor = require("../models/Decor");
const Attribute = require("../models/Attribute");

// ── Listing context — the live catalogue data the merged FULL brain needs ────
//
// Absorbed from services/decorListing.js when the two brains merged (2026-08-19).
// One copy, shared by A2S and POST /decor/ai-analyze, so the two can never drift
// into supplying different context to the same prompt.
//
// existing_names is CATEGORY-SCOPED whenever we know the category. The
// don't-repeat-a-name rule is inert without it — the model has no other way of
// knowing what it has already named, and it reliably reaches for the same few
// names otherwise.
//
// When the category is NOT known yet, names for EVERY category are sent instead
// of none. This happens on the A2S cold path only: the merged brain reads the
// category and writes the name in the same call, so on a cache miss there is no
// category to scope by at the moment the call is made. Sending everything costs
// tokens but keeps the rule working; sending nothing would silently disable it.
const buildListingContext = async (category) => {
  const cat = String(category || "").trim();
  const [existing, attrs] = await Promise.all([
    cat
      ? Decor.find({ category: cat }, "name").lean()
      : Decor.find({}, "name").lean(),
    Attribute.find({}, "name list").lean(),
  ]);
  const existingNames = existing.map((d) => d.name).filter(Boolean);
  const attributeOptions = {};
  attrs.forEach((a) => {
    attributeOptions[a.name] = a.list || [];
  });
  return { existingNames, attributeOptions, scopedTo: cat || null };
};

module.exports = { buildListingContext };

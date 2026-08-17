const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const Mixed = mongoose.Schema.Types.Mixed;

// ── Pin-level READ cache — the demo panel's vision result, remembered ────────
//
// WHY THIS EXISTS (founder, 2026-08): "if an image is revisited or rechecked
// then the pricing must not differ". The vision model runs at temperature 1.0
// and no determinism control is available on it (temperature/top_p/top_k are all
// rejected on claude-sonnet-5), so two reads of the SAME photo measure it
// differently — ±25% on backdrop width, up to +74% on the resulting price. That
// is the whole defect. Reading once and replaying the read removes it.
//
// WHAT IS CACHED: the ANALYSIS ONLY — the postProcess output of the demo vision
// call. NOT the computed price ladder. That is a deliberate ruling: comparables
// move only when the catalogue is edited, and when Rohaan edits a price the new
// number is the WANTED answer, not a stale-cache bug. So a replay re-runs
// pinTextCheck, occasion resolution and the comparable query every time.
//
// WHY ITS OWN COLLECTION, NOT DecorDraft: most cached pins are browsed and
// never added to the store. Parking them in the approval queue would fill it
// with items nobody asked to approve.
//
// This collection is a CACHE, not a record of truth: it may be dropped whole
// and the system still works — it just pays for fresh reads again.

const DecorImageReadSchema = new mongoose.Schema(
  {
    // ── The key. Both are matched with $or (see services/decorReadCache) ─────
    pinId: { type: String, default: "" },
    normalizedUrl: { type: String, default: "" },
    // The last URL that produced this entry — diagnostics only, never matched
    // on (it still carries the /564x/ size segment and the query string).
    sourceUrl: { type: String, default: "" },

    // The demo-mode analysis, stored verbatim and replayed verbatim. Mixed
    // because the vision schema is the vision layer's business, not the cache's.
    analysis: { type: Mixed, default: () => ({}) },
    // Which vision mode wrote it. Only "demo" is written today; the field exists
    // so a future full/listing entry can never be replayed into the demo path by
    // accident (lookupRead filters on it).
    mode: { type: String, default: "demo" },

    // Provenance, surfaced to the panel and copied onto any draft built from it.
    firstReadAt: { type: Date, default: Date.now },
    lastServedAt: { type: Date, default: null },
    // Hits served from this entry (cheap usefulness signal, not billing).
    hits: { type: Number, default: 0 },
    // How many AI reads have written this entry: 1 on create, +1 per reanalyse.
    reads: { type: Number, default: 1 },
    lastReanalysedAt: { type: Date, default: null },
    readBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// Both key paths are indexed because the lookup $ors over them, and an $or can
// only use an index if EVERY branch has one.
DecorImageReadSchema.index({ pinId: 1 }, { sparse: true });
DecorImageReadSchema.index({ normalizedUrl: 1 });

module.exports =
  mongoose.models.DecorImageRead || mongoose.model("DecorImageRead", DecorImageReadSchema);

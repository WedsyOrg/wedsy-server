const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const Mixed = mongoose.Schema.Types.Mixed;

// ── A2S ("Add to Store") — the approval QUEUE ────────────────────────────────
// Its OWN collection. A DecorDraft is never a product: nothing here is visible
// in the store until an approver publishes it into `decors` (which stamps
// publishedDecorId). Staff click A2S on a Pinterest pin in the décor Chrome
// extension; the item lands here; an approver edits, prices and publishes it.
//
// THE TRAINING LOOP (the reason this collection exists):
// every approval records the triple { AI suggestion → human price → why }.
// pricing.aiSuggested is the "before", pricing.finalPrice/reason the "after".
// Rejected drafts are KEPT for the same reason — "AI proposed, human declined"
// is a training signal, so nothing here is ever deleted.

const DecorDraftSchema = new mongoose.Schema(
  {
    // ── The Pinterest source — THE DEDUPE KEY ────────────────────────────────
    // pinId wins when present; normalizedUrl is the fallback match (and is
    // derived from url at create time — see services/DecorDraftService).
    sourceImage: {
      url: { type: String, default: "" },
      pinId: { type: String, default: "" },
      normalizedUrl: { type: String, default: "" },
      pinText: { type: String, default: "" },
    },

    // OUR asset: the server fetches the Pinterest URL and re-uploads to S3, so
    // the catalogue never depends on a pinimg URL continuing to resolve.
    storedImage: { type: String, default: "" },

    // ── IMMUTABLE (1/2) — the FULL UNTRIMMED analysis, both brains ───────────
    // { listing, pricing, categoryDisagreement } — see DecorDraftService.
    // shapeClientResponse trims what we RETURN to the extension; this stores
    // everything, because the trimmed fields (observedBand, comparables,
    // sizeBasis, complexity.reasoning, confidence gates) ARE the evidence half
    // of the training pair. Enforced immutable below.
    aiAnalysis: { type: Mixed, default: () => ({}) },

    // What the AI proposed — the autofill source for the approver's form. Kept
    // separate from `draft` so "what the AI said" survives every human edit.
    suggested: {
      category: { type: String, default: "" },
      name: { type: String, default: "" },
      description: { type: String, default: "" },
      tags: { type: [String], default: [] },
      included: { type: [String], default: [] },
      attributes: { type: Mixed, default: () => ({}) },
      measurements: { type: Mixed, default: () => ({}) },
      priceLadder: { type: Mixed, default: () => ({}) },
    },

    // ── The EDITABLE half — what the approver actually publishes ─────────────
    // category AND productCode are both editable: the AI misclassifies, and a
    // wrong category is a ~2× price error. Seeded from `suggested` at create.
    draft: {
      category: { type: String, default: "" },
      productCode: { type: String, default: "" },
      name: { type: String, default: "" },
      description: { type: String, default: "" },
      tags: { type: [String], default: [] },
      included: { type: [String], default: [] },
      unit: { type: String, default: "" },
      attributes: { type: Mixed, default: () => ({}) },
      measurements: { type: Mixed, default: () => ({}) },
      productVariation: { type: Mixed, default: () => ({}) },
    },

    // ── Read provenance (2026-08-17) — WHICH vision read this draft carries ──
    // aiAnalysis is immutable, so whatever read was in hand at create time is
    // frozen into the training data forever. That makes "where did this read come
    // from, and how old was it" part of the record, not a debugging nicety: a
    // stale cache entry produces a training pair whose "before" was never a live
    // look at the image. cacheId points at models/DecorImageRead (a CACHE — the
    // entry may legitimately be gone; then these fields are all we have).
    sourceRead: {
      // "cache" (the panel's read, replayed) | "fresh" (A2S read it itself)
      source: { type: String, default: "" },
      cacheId: { type: ObjectId, ref: "DecorImageRead", default: null },
      firstReadAt: { type: Date, default: null }, // when the IMAGE was first read
      usedAt: { type: Date, default: null }, // when THIS draft consumed it
    },

    pricing: {
      // ── IMMUTABLE (2/2) — the full AI price ladder as first computed ───────
      aiSuggested: { type: Mixed, default: () => ({}) },
      // ── IMMUTABLE — WHAT THE CLIENT WAS ACTUALLY QUOTED ────────────────────
      // The demo panel and the draft engine are two different pricing models and
      // caching the read cannot make them agree. Ruling (2026-08-17): the panel
      // wins. `midpoint` is the pre-filled price in the approval modal — the
      // ×1.15 negotiating headroom INCLUDED, so the published store price matches
      // the figure the client heard on the call. Rohaan edits it in the modal;
      // finalPrice is what he settles on, and (midpoint → finalPrice → reason) is
      // the training pair that now matters most, since midpoint is the number a
      // human actually quoted.
      //
      // NULL when A2S could not replay the panel (no cached read for this pin —
      // e.g. A2S clicked without the panel ever pricing it). Deliberately not
      // faked: an estimate computed here was never quoted to anyone.
      panelQuote: { type: Mixed, default: null },
      // ── PER-TIER LEARNING RECORD (2026-08-20) ─────────────────────────────
      // ADDITIVE, not a replacement. A draft used to publish ONE price row, so
      // one finalPrice/overridden/reason described the whole decision. It now
      // publishes every tier the approver kept, so the decision is per tier —
      // but the three fields below keep their exact meaning for the HEADLINE
      // tier (the first published row), so nothing already stored in the
      // collection loses its interpretation or needs backfilling.
      //
      // One entry per PUBLISHED row: what the AI ladder suggested for that tier,
      // what the panel quoted (only the tier the panel actually quoted on), what
      // the human set, and why if it differs.
      // NOT immutable — it is written once at approve time, alongside finalPrice.
      // The "before" evidence it is measured against (aiSuggested, panelQuote) is.
      tierDecisions: {
        type: [
          {
            tier: { type: String, default: "" },        // artificial|mixed|natural|flat
            name: { type: String, default: "" },        // the published row's label
            aiSuggested: { type: Number, default: null },
            panelQuote: { type: Number, default: null },
            finalPrice: { type: Number, default: null },
            overridden: { type: Boolean, default: false },
            reason: { type: String, default: "" },
            deltaPct: { type: Number, default: null },  // final vs the AI figure
          },
        ],
        default: [],
      },

      // ── DIMENSION CORRECTIONS (2026-08-20) ────────────────────────────────
      // A SIBLING of tierDecisions, not a row inside it. It cannot live there:
      // finalPrice is taken from tierDecisions[0], so a "length" row at index 0
      // would silently become the product's price — and it would also break
      // tierOf() normalisation, the per-tier approval UI and the /analysis
      // response, all of which assume every entry is a flower tier.
      //
      // Before this existed a dimension-only correction had nowhere to put its
      // reason: pricing.reason derived exclusively from an overridden TIER, so
      // changing only the height set it to "" and the approver's explanation was
      // discarded without a word.
      //
      // `aiRead` is derived SERVER-SIDE from the immutable aiAnalysis, never
      // taken from the request — same principle as aiSuggested. The client is
      // trusted for what the human chose, never for what the AI said.
      measurementDecisions: {
        type: [
          {
            field: { type: String, default: "" }, // length | width | height
            aiRead: { type: Number, default: null },
            finalValue: { type: Number, default: null },
            overridden: { type: Boolean, default: false },
            reason: { type: String, default: "" },
            deltaPct: { type: Number, default: null },
          },
        ],
        default: [],
      },
      finalPrice: { type: Number, default: null },
      // overridden=false is the POSITIVE signal (the human accepted the AI
      // price) and needs no reason. overridden=true REQUIRES one.
      overridden: { type: Boolean, default: false },
      reason: { type: String, default: "" },
      decidedBy: { type: ObjectId, ref: "Admin", default: null },
      decidedAt: { type: Date, default: null },
    },

    status: {
      type: String,
      enum: ["queued", "approved", "rejected"],
      default: "queued",
      index: true,
    },

    addedBy: { type: ObjectId, ref: "Admin", default: null },
    addedAt: { type: Date, default: Date.now },

    // Set on approve — the published product. Also the "already in the store"
    // dedupe answer.
    publishedDecorId: { type: ObjectId, ref: "Decor", default: null },

    rejection: {
      reason: { type: String, default: "" },
      rejectedBy: { type: ObjectId, ref: "Admin", default: null },
      rejectedAt: { type: Date, default: null },
    },

    // Full decision history — append-only audit of every state change.
    history: {
      type: [
        {
          action: { type: String, default: "" }, // queued | approved | rejected | re_added
          by: { type: ObjectId, ref: "Admin", default: null },
          at: { type: Date, default: Date.now },
          note: { type: String, default: "" },
        },
      ],
      default: [],
    },

    // Set when this draft was created via { force: true } after an earlier
    // rejection of the same pin — links the retry to what was declined.
    supersedesDraftId: { type: ObjectId, ref: "DecorDraft", default: null },
  },
  { timestamps: true }
);

// Dedupe lookups. pinId is sparse (not every pin exposes one); normalizedUrl is
// the fallback key. Deliberately NOT unique — a rejected pin may legitimately be
// re-added with { force: true }, which creates a second draft on purpose.
DecorDraftSchema.index({ "sourceImage.pinId": 1 }, { sparse: true });
DecorDraftSchema.index({ "sourceImage.normalizedUrl": 1 });
DecorDraftSchema.index({ status: 1, addedAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// THE NON-NEGOTIABLE: aiAnalysis and pricing.aiSuggested are write-once.
//
// They are the "before" half of every training pair. If any update path can
// overwrite them, the feedback loop silently stops working — silently is the
// dangerous part, so these hooks THROW rather than quietly stripping the field.
// (Mongoose's own `immutable: true` strips silently on update and no-ops on
// save, which would hide exactly the bug we care about — hence explicit hooks.)
//
// Mixed paths also give us a second layer for free: an in-place deep mutation
// that never calls markModified() is not persisted by Mongoose at all, and one
// that DOES call it trips the save hook below.
// ─────────────────────────────────────────────────────────────────────────────
// pricing.panelQuote and sourceRead joined the list on 2026-08-17: both are
// "before" evidence in exactly the same sense as aiSuggested — panelQuote is the
// number a human quoted the client, sourceRead says which read produced it. If
// either can be rewritten after the fact, an approval's training pair can be
// made to look like something that never happened.
const IMMUTABLE_PATHS = ["aiAnalysis", "pricing.aiSuggested", "pricing.panelQuote", "sourceRead"];

const isImmutablePath = (path) =>
  IMMUTABLE_PATHS.some((p) => path === p || path.startsWith(`${p}.`));

// Collect every field an update operation would touch, resolving $-operators
// ($set/$unset/$push/…) to the dotted paths underneath them.
const immutableHitsIn = (update) => {
  const hits = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) {
        scan(obj[key]);
        continue;
      }
      if (isImmutablePath(key)) hits.push(key);
    }
  };
  scan(update);
  return hits;
};

const guardUpdate = function (next) {
  const hits = immutableHitsIn(this.getUpdate() || {});
  if (hits.length) {
    return next(
      new Error(
        `DecorDraft: ${hits.join(", ")} is immutable after creation ` +
          `(the AI "before" half of the training pair). Refusing the update.`
      )
    );
  }
  next();
};

for (const op of [
  "findOneAndUpdate",
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndReplace",
]) {
  DecorDraftSchema.pre(op, guardUpdate);
}

DecorDraftSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const touched = IMMUTABLE_PATHS.filter((p) => this.isModified(p));
  if (touched.length) {
    return next(
      new Error(
        `DecorDraft: ${touched.join(", ")} is immutable after creation ` +
          `(the AI "before" half of the training pair). Refusing the save.`
      )
    );
  }
  next();
});

// Exported for the test suite.
DecorDraftSchema.statics.IMMUTABLE_PATHS = IMMUTABLE_PATHS;

module.exports =
  mongoose.models.DecorDraft || mongoose.model("DecorDraft", DecorDraftSchema);

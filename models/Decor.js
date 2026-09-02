const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const DecorSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: false,
      // enum: ["BestSeller", "Popular", ""],
      default: "",
    },
    // ── HOW THIS PRODUCT GOT HERE (2026-08-20) ───────────────────────────────
    // "extension" = published from the A2S approval queue (Chrome extension →
    // draft → approve). UNSET ("") = created directly, which covers every
    // manually-added product and all ~800 that predate A2S.
    //
    // Deliberately NOT written as "manual" on POST /decor: an explicit value
    // there would need a backfill to be meaningful, and absence already says the
    // same thing. Deliberately NOT a string in `tags` either — tags are edited
    // freely by approvers and this must survive that.
    // Same vocabulary as decorPricing's `source: "extension"`: both mean "this
    // came from the extension", so they read as one concept.
    source: { type: String, default: "" },
    // ── WHO PUT THIS PRODUCT IN THE CATALOGUE (2026-08-20) ───────────────────
    // Set from the authenticated admin on POST /decor, and to the APPROVER on
    // A2S approve — the same meaning on both paths, "the person who published
    // it", which is what makes the filter usable.
    //
    // NULL on every product that predates this, permanently. The information was
    // never captured and cannot be recovered from the documents, the timestamps
    // or git history, so the UI shows "Unknown" and that is the correct answer —
    // a heuristic here would be a guess wearing the clothes of a record.
    //
    // For A2S products the person who CLICKED A2S can differ from the approver by
    // days; both are already returned by GET /decor/:_id/analysis as addedBy /
    // approvedBy. This field is deliberately the publisher, not the finder.
    createdBy: { type: ObjectId, ref: "Admin", default: null },
    rating: { type: Number, default: 0, required: true },
    productVisibility: { type: Boolean, default: false },
    productAvailability: { type: Boolean, default: false },
    spotlight: { type: Boolean, default: false },
    spotlightColor: { type: String, default: "" },
    // S3 (store workspace, additive) — curation order inside each collection.
    // null = unordered (sorts after ordered items, createdAt fallback).
    bestSellerOrder: { type: Number, default: null },
    popularOrder: { type: Number, default: null },
    spotlightOrder: { type: Number, default: null },
    name: { type: String, required: true },
    unit: { type: String, required: true },
    tags: { type: [String], required: true, default: [] },
    image: { type: String, required: true, default: "" },
    additionalImages: { type: [String], default: [] },
    thumbnail: { type: String, required: true, default: "" },
    video: { type: String, default: "" },
    description: { type: String, default: "" },
    pdf: { type: String, default: "" },
    attributes: { type: [{ name: String, list: [String] }], default: [] },
    productVariation: {
      colors: { type: [String], required: true, default: [] },
      occassion: { type: [String], required: true, default: [] },
      flowers: { type: [String], required: true, default: [] },
      fabric: { type: [String], default: [] },
      style: {
        type: String,
        required: false,
        enum: ["Modern", "Traditional", ""],
        default: "",
      },
      nameboardMaterial: { type: [String], default: [] },
    },
    productInfo: {
      id: { type: String, default: "" },
      measurements: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        area: { type: Number, default: 0 },
        radius: { type: Number, default: 0 },
        other: { type: String, default: "" },
      },
      included: { type: [String], default: [] },
      // ── NOT the décor pricing source (ruled 2026-09-02) ──────────────────
      // Despite the newer-looking name, this shape is NOT what prices a décor
      // product. productTypes[] below is: Build & Bill resolves the billed tier
      // from it (DraftEventService.js:702), the tier dropdown is built from it,
      // and the store filters/sorts on it. This variant block is absent on
      // 499/800 products, zero-stamped (all defaults) on ~200 more, and where
      // both shapes exist it disagrees with productTypes by thousands of
      // rupees. Reading a price from here puts a wrong number in front of a
      // client. (DecorPackage has its own variant that IS priced from — that
      // is packages, not this.)
      variant: {
        artificialFlowers: {
          costPrice: { type: Number, required: true, default: 0 },
          sellingPrice: { type: Number, required: true, default: 0 },
          discount: { type: Number, required: true, default: 0 },
        },
        mixedFlowers: {
          costPrice: { type: Number, required: true, default: 0 },
          sellingPrice: { type: Number, required: true, default: 0 },
          discount: { type: Number, required: true, default: 0 },
        },
        naturalFlowers: {
          costPrice: { type: Number, required: true, default: 0 },
          sellingPrice: { type: Number, required: true, default: 0 },
          discount: { type: Number, required: true, default: 0 },
        },
      },
      quantity: { type: Number, required: true, default: 1 },
      minimumOrderQuantity: { type: Number, required: true, default: 1 },
      maximumOrderQuantity: { type: Number, required: true, default: 1 },
      SKU: { type: String, default: "" },
    },
    rawMaterials: { type: [{ name: String, quantity: Number }], default: [] },
    seoTags: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
      image: { type: String, default: "" },
    },
    productVariants: {
      type: [
        {
          name: { type: String, default: "" },
          priceModifier: { type: Number, required: true, default: 0 },
          image: { type: String, default: "" },
        },
      ],
      default: [],
    },
    productTypes: {
      type: [
        {
          name: { type: String, default: "" },
          costPrice: { type: Number, required: true, default: 0 },
          sellingPrice: { type: Number, required: true, default: 0 },
          discount: { type: Number, required: false, default: 0 },
        },
      ],
      default: [],
    },
    productAddOns: {
      type: [ObjectId],
      ref: "Decor",
      default: [],
    },
  },
  { timestamps: true }
);

DecorSchema.index({ name: "text", description: "text" });

// ── The July P0 fix: productInfo.id must be unique ───────────────────────────
// The partial unique index "productInfo_id_unique" is DELIBERATELY NOT declared
// here. Declaring it would let Mongoose's autoIndex build it on every app boot
// — an unique-index build against the live collection, triggered by a restart,
// is not something we want happening implicitly.
//
// It is created ONCE, deliberately, by:
//     node scripts/migrate-decor-productid-unique-index.js --confirm
//
// Spec (kept here so the schema still documents the constraint):
//     key    { "productInfo.id": 1 }
//     unique true
//     partial { "productInfo.id": { $type: "string", $gt: "" } }
// PARTIAL so blank/absent codes are exempt — a plain unique index would make
// every future "" collide with the first one.
//
// ⚠️ Because the index is not declared on the schema, Model.syncIndexes() would
// DROP it. Do not call syncIndexes() on Decor; use the migration script.

module.exports = mongoose.model("Decor", DecorSchema);

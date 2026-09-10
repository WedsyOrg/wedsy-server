const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// COUPLE APP § 06.1 / § 05.1 — ONE GIFT on the registry.
//
// § 06.1 sketches `contributions[]` as an array on this document. It is a
// separate collection here (models/Contribution) for two reasons the screens
// force: the couple thanks PEOPLE, not line items, so a contribution has to be
// addressable on its own (`PATCH /contributions/:id { thanked }`), and group
// gifting means an item accumulates rows from strangers indefinitely — an
// unbounded embedded array on a document every guest's page read touches.
//
// `funded` is therefore a DENORMALISED running total, written in the same
// transaction as the Contribution that moved it (§ 06.3). It is never the
// place a total is derived from at read time — services/CoupleWallet's pure
// helpers sum the contributions — it is what makes "two guests paying in full
// at once cannot both succeed" a single-document guard.
const RegistryItemSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    image: { type: String, default: "" },      // S3 URL, or the scraped source image
    price: { type: Number, default: 0, min: 0 }, // rupees; 0 = "add & set a price" not done yet
    sourceUrl: { type: String, default: "", maxlength: 2000 },
    source: { type: String, default: "", maxlength: 120 }, // the shop's hostname

    funded: { type: Number, default: 0, min: 0 },  // Σ settled contributions, denormalised
    pinned: { type: Boolean, default: false },     // § 05.1 — one item, "the one we're dreaming of most"
    sortOrder: { type: Number, default: 0 },

    // Retired rather than deleted once money has arrived against it: a guest's
    // contribution must never point at a row that is gone.
    archivedAt: { type: Date, default: null },

    createdBy: { type: ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

RegistryItemSchema.index({ weddingId: 1, sortOrder: 1 });
// The public grid reads the live rows for one wedding.
RegistryItemSchema.index({ weddingId: 1, archivedAt: 1 });

module.exports = mongoose.models.RegistryItem || mongoose.model("RegistryItem", RegistryItemSchema);

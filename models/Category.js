const mongoose = require("mongoose");

const CategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: -1,
    },
    status: {
      type: Boolean,
      required: true,
      default: false,
    },
    images: {
      squareImage: {
        type: String,
        default: "",
      },
      portaitImage: {
        type: String,
        default: "",
      },
      landscapeImage: {
        type: String,
        default: "",
      },
    },
    attributes: {
      type: [String],
      required: true,
      default: [],
    },
    addOns: {
      type: [String],
      required: true,
      default: [],
    },
    productTypes: {
      type: [String],
      required: true,
      default: [],
    },
    platformAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    flooringAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    multipleAllowed: {
      type: Boolean,
      required: true,
      default: false,
    },
    // ── Upload-intake behaviour flags (2026-09) ─────────────────────────────
    // Both default TRUE so the ~12 pre-flag categories behave exactly as
    // before with no backfill. ⚠️ READERS MUST TEST `!== false`, never
    // `=== true`: a .lean() read of a pre-flag document returns undefined for
    // these paths (schema defaults fill hydrated docs, not lean ones), and a
    // `=== true` check would silently flip every old category to false.
    // asksOccasion — does the upload form ask for an occasion in this category.
    // Form-driving only: the server accepts "" as an explicit none either way.
    asksOccasion: {
      type: Boolean,
      default: true,
    },
    // aiPriced — does an upload in this category get an AI price at all.
    // false = the draft lands with no quote (uploadQuote status "not_priced")
    // and the approver sets the price. Also lifts the CATEGORY_LIST
    // requirement on upload: an unpriced category never reaches the vision
    // pricing vocabulary, so it needs no calibration gate.
    aiPriced: {
      type: Boolean,
      default: true,
    },
    // codePrefix — the product-code prefix for this category (e.g. "cs" →
    // cs001). prefixForCategory consults this FIRST, so a new category mints
    // codes from its first draft instead of arriving blank until someone
    // hand-codes products. Empty = today's behaviour (derive from existing
    // coded products, then FALLBACK_PREFIX). Normalised to lowercase letters
    // because the code format is absolute: parseCode reads ^letters+digits$,
    // and a stored "cs-1" would mint codes the parser cannot read back.
    // Prefixes are NOT checked for collision with existing ones — two
    // categories sharing a prefix will interleave their numbering. Not
    // guarded, deliberately: the generator still behaves correctly (max
    // suffix and reservations are prefix-global already).
    codePrefix: {
      type: String,
      default: "",
      // undefined passes THROUGH: an update that omits the field must not have
      // the setter manufacture "" out of it — Mongoose strips undefined from
      // $set, so an old-client edit leaves the stored prefix alone (verified;
      // the booleans get this for free, a setter has to opt in).
      set: (v) => (v === undefined ? undefined : String(v || "").trim().toLowerCase().replace(/[^a-z]/g, "")),
    },
    adminEventToolView: {
      type: String,
      enum: ["single", "group"],
    },
    websiteView: {
      type: String,
      enum: ["multiple", "single"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", CategorySchema);

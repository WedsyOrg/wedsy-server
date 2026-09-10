const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const Mixed = mongoose.Schema.Types.Mixed;
const { THEME_ID, PALETTE_ID, FONT_ID } = require("../utils/coupleEnums");

// COUPLE APP § 06.1 / § 04 — THE WEDDING WEBSITE, and with it the wedding's
// one PUBLIC IDENTITY: its slug. Both public routes resolve on this document —
// GET /site/:slug (the site) and GET /registry/:slug (the gift registry) — so
// the slug is unique across the collection, not per wedding.
//
// The registry reads its slug and palette from here but does NOT need
// publishedAt: § 05.1 is explicit that the registry "works on its own — no
// website needed". A registry link therefore resolves on a Website document
// whose publishedAt is still null; only the SITE route requires publishedAt.
const WebsiteSchema = new mongoose.Schema(
  {
    // NOT `index: true` here. The unique index below is declared on the same
    // key, and both resolve to the name `weddingId_1` — so mongoose asks the
    // server to build one index twice with two different specs and the second
    // attempt fails with IndexKeySpecsConflict (code 86), taking every read of
    // this collection down with it. One declaration, at the bottom, unique.
    weddingId: { type: ObjectId, ref: "Event", required: true },

    // Lowercase, hyphenated, globally unique. sparse so a wedding can hold a
    // draft website before the couple has chosen a name for it.
    slug: { type: String, trim: true, lowercase: true, maxlength: 80, index: { unique: true, sparse: true } },

    themeId: { type: String, enum: THEME_ID, default: "tp1" },
    paletteId: { type: String, enum: PALETTE_ID, default: "p1" },
    fontId: { type: String, enum: FONT_ID, default: "f1" },

    sections: {
      cover: { type: Boolean, default: true },
      story: { type: Boolean, default: true },
      events: { type: Boolean, default: true },
      gallery: { type: Boolean, default: true },
      registry: { type: Boolean, default: false },
      rsvp: { type: Boolean, default: true },
    },

    // THEME-INDEPENDENT on purpose (§ 04): the couple's words are keyed by
    // blockId and their photographs by slotId, so switching tp1 → tp4 re-renders
    // the same content instead of asking them to type it again. Free-form maps,
    // hence Mixed.
    content: { type: Mixed, default: () => ({}) },
    photos: { type: Mixed, default: () => ({}) },

    privacy: {
      // § 06.4 — linkOnly means the public page must carry noindex.
      linkOnly: { type: Boolean, default: true },
      // A BCRYPT HASH, never a password, and never serialised to a client:
      // the public read returns privacy.passwordRequired: boolean instead
      // (see the contract in wedsy-user lib/plan/api-public.js).
      password: { type: String, default: "", select: false },
    },

    publishedAt: { type: Date, default: null },

    // ── The registry's own presentation ──────────────────────────────────────
    // § 05.1's "A note from the couple" and the grid/list choice. They sit on
    // this document rather than on a registry model because they belong to the
    // registry AS A PAGE, and this is the document that owns the page's slug,
    // palette and font. Nothing here is read by the site route.
    registry: {
      intro: { type: String, default: "", maxlength: 2000 },
      layout: { type: String, enum: ["grid", "list"], default: "grid" },
    },
  },
  { timestamps: true }
);

// One website per wedding.
WebsiteSchema.index({ weddingId: 1 }, { unique: true });

module.exports = mongoose.models.Website || mongoose.model("Website", WebsiteSchema);

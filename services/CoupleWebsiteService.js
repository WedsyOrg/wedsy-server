/* THE COUPLE'S SIDE OF THE WEBSITE (§ 04, § 06.2).
 *
 * Six endpoints' worth of reads and writes. Every decision this file could
 * make, it does not: the slug rules, the settings whitelist, the content merge
 * and the shape of a response all live in services/CoupleWebsiteRules.js,
 * which is pure and tested. This file talks to mongoose and to S3.
 *
 * ── ONE WEBSITE PER WEDDING, CREATED ON FIRST READ ────────────────────────
 * The builder opens before the couple has chosen anything, so GET creates the
 * document with the model's own defaults and NO SLUG. `slug` is sparse-unique,
 * so any number of weddings may hold an unnamed draft; only a chosen address
 * is contended.
 *
 * ── UNIQUENESS IS THE INDEX, NEVER A READ-THEN-WRITE ──────────────────────
 * `Website.slug` carries `{ unique: true, sparse: true }`. Two couples typing
 * "sharma-wedding" in the same second both pass a findOne() check and one of
 * them silently loses their address. So the write is attempted and the
 * duplicate-key error (E11000) is what becomes the 409. The slug-check
 * endpoint's findOne is a COURTESY to the typist, and says so.
 */

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const sharp = require("sharp");

const Website = require("../models/Website");
const rules = require("./CoupleWebsiteRules");
const activityService = require("./CoupleActivityService");
const { uploadBufferToS3, extensionFor } = require("../utils/s3Upload");

const BCRYPT_ROUNDS = 10;

/** A refusal the controller's wrapper turns into a response. */
const fail = (status, code, message, extra) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
};

/** Is this the duplicate-key error the unique slug index throws? */
const isDuplicateKey = (error) =>
  Boolean(error && (error.code === 11000 || error.code === 11001 || /E11000/.test(String(error.message || ""))));

/**
 * The wedding's website document, created on first read.
 *
 * `select("+privacy.password")` because callers need to know WHETHER there is
 * a hash (`isGated`) — never its value, which no shaping function in
 * CoupleWebsiteRules emits.
 */
const ensure = async (weddingId) => {
  const found = await Website.findOne({ weddingId }).select("+privacy.password").lean();
  if (found) return found;
  try {
    const created = await Website.create({ weddingId });
    return created.toObject();
  } catch (error) {
    // Two tabs opened the builder at once; the { weddingId } unique index
    // refused the second. The first one's document is the answer.
    if (isDuplicateKey(error)) {
      const raced = await Website.findOne({ weddingId }).select("+privacy.password").lean();
      if (raced) return raced;
    }
    throw error;
  }
};

/** GET /wedding/:id/website */
const get = async (couple) => rules.couplePayload(await ensure(couple.weddingId));

/**
 * PUT /wedding/:id/website — theme, palette, typeface, sections, slug, privacy.
 *
 * The patch is built by rules.settingsPatch, which cannot emit `content` or
 * `photos`: switching a theme carries the couple's words and photographs
 * across because nothing here is able to touch them (§ 04.10).
 */
const applySettings = async (couple, body) => {
  const website = await ensure(couple.weddingId);
  const { patch, fields, passwordPlain } = rules.settingsPatch(body);

  if (Object.keys(fields).length) {
    throw fail(422, "validation", "Some of that could not be saved.", { fields });
  }

  // The one value that is transformed rather than stored: a plaintext password
  // becomes a bcrypt hash here and nowhere else, and "" clears the gate.
  if (passwordPlain !== undefined) {
    patch["privacy.password"] = passwordPlain ? await bcrypt.hash(passwordPlain, BCRYPT_ROUNDS) : "";
  }

  if (!Object.keys(patch).length) return rules.couplePayload(website);

  let saved;
  try {
    saved = await Website.findOneAndUpdate(
      { weddingId: couple.weddingId },
      { $set: patch },
      { new: true }
    ).select("+privacy.password").lean();
  } catch (error) {
    // THE RACE, caught where it actually happens. Another wedding holds this
    // address; nothing was written here.
    if (isDuplicateKey(error)) throw fail(409, "slug_taken", "Another couple has that address. Try another.", { slug: patch.slug || "" });
    throw error;
  }

  if (patch.slug) {
    await activityService.record({
      weddingId: couple.weddingId,
      actorType: "couple",
      actor: { id: couple.userId, name: (couple.user && couple.user.name) || "" },
      action: "website.slug",
      objectType: "website",
      objectId: saved && saved._id,
      summary: `set the website address to ${patch.slug}`,
    });
  }

  return rules.couplePayload(saved || website);
};

/**
 * PUT /wedding/:id/website/content — the debounced words-and-photographs save.
 *
 * Content is keyed by blockId and photos by slotId, NEVER by theme (§ 04.10):
 * this write does not know or record which theme is on, which is exactly why a
 * theme switch keeps everything.
 */
const saveContent = async (couple, body) => {
  const website = await ensure(couple.weddingId);
  const merged = rules.mergeContent(website, body);
  if (!merged.ok) throw fail(422, "validation", "Some of that could not be saved.", { fields: merged.fields });

  const saved = await Website.findOneAndUpdate(
    { weddingId: couple.weddingId },
    { $set: { content: merged.content, photos: merged.photos } },
    { new: true }
  ).select("+privacy.password").lean();

  return { ok: true, saved: merged.touched.length, ...rules.couplePayload(saved || website) };
};

/**
 * GET /wedding/:id/website/slug/check?slug=
 *
 * A COURTESY, and the comment is the point: this read cannot make an address
 * safe to take, because another couple may claim it between this answer and
 * the save. The unique index in applySettings is what actually decides. This
 * exists so the typist sees "taken" while they type rather than on submit.
 */
const checkSlug = async (couple, raw) => {
  const check = rules.validateSlug(raw);
  if (!check.ok) return { available: false, slug: check.slug, reason: check.reason, message: check.message };

  const holder = await Website.findOne({ slug: check.slug }, { weddingId: 1 }).lean();
  const mine = holder && String(holder.weddingId) === String(couple.weddingId);
  if (holder && !mine) {
    return { available: false, slug: check.slug, reason: "taken", message: "Another couple has that address. Try another." };
  }
  return { available: true, slug: check.slug, reason: mine ? "yours" : "", message: "" };
};

/**
 * POST /wedding/:id/website/publish — stamps publishedAt.
 *
 * Publishing twice is not an error and does not move the date: the couple who
 * tapped twice has published, and the second answer should equal the first.
 */
const publish = async (couple, now = new Date()) => {
  const website = await ensure(couple.weddingId);
  if (!website.slug) throw fail(422, "no_slug", "Choose your website address before you publish.");

  const already = Boolean(website.publishedAt);
  const saved = already
    ? website
    : await Website.findOneAndUpdate(
        { weddingId: couple.weddingId },
        { $set: { publishedAt: now } },
        { new: true }
      ).select("+privacy.password").lean();

  if (!already) {
    await activityService.record({
      weddingId: couple.weddingId,
      actorType: "couple",
      actor: { id: couple.userId, name: (couple.user && couple.user.name) || "" },
      action: "website.published",
      objectType: "website",
      objectId: saved && saved._id,
      summary: "published the wedding website",
    });
    // ── NOTIFICATION TRIGGER, NOT ADDED HERE ────────────────────────────────
    // Publishing is the moment a couple wants to tell people. The trigger this
    // wants is `couple_website_published` (the link, to the couple themselves),
    // through services/NotificationService.js, WhatsApp via the Meta Cloud API
    // — NEVER Aisensy. Read the Notification System spec in Notion before
    // adding it; notifications are TRIGGERS ONLY, and none was added in this
    // milestone (see docs/couple-app-api.md § Website).
  }

  return {
    ok: true,
    alreadyPublished: already,
    publishedAt: (saved && saved.publishedAt) || null,
    slug: saved.slug,
    // Built from the environment, never hardcoded (hard rule 3). Absent when
    // the deploy has not said what its public origin is.
    url: process.env.PUBLIC_SITE_BASE_URL
      ? `${String(process.env.PUBLIC_SITE_BASE_URL).replace(/\/$/, "")}/site/${saved.slug}`
      : null,
  };
};

/* ── photographs ──────────────────────────────────────────────────────────── */

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;   // a phone photograph, generously
const MAX_EDGE = 2400;                        // the largest a wedding website ever needs
const ALLOWED_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif"];

/**
 * POST /wedding/:id/website/photos — multipart in, `{ slotId, mediaId }` out.
 *
 * ── THE PIPELINE, AND WHAT IT IS NOT (§ 04.10) ─────────────────────────────
 * § 04.10 asks for "upload → resize to the slot's aspect → WebP → CDN, storing
 * the original for re-crops when the theme changes". Three of those four are
 * here: the original is stored untouched, a WebP derivative capped at
 * MAX_EDGE on its long side is what the slot points at, and both go through
 * utils/s3Upload — this repo's ONE S3 path, not a second one.
 *
 * THE SLOT ASPECT IS NOT CROPPED, and deliberately: the slot → aspect table is
 * a fact of the theme layer and lives in wedsy-user's lib/plan/website/themes,
 * not on this server. Cropping to a guessed aspect would cut a face out of a
 * photograph, and the original is stored precisely so that re-crop can happen
 * later, once the aspect table is shared. Reported honestly in the milestone
 * notes rather than left to be discovered.
 *
 * The CDN is an env var (MEDIA_CDN_BASE) applied to the returned URLs when the
 * deploy has one, never a hardcoded host (hard rule 3).
 */
const cdn = (url) => {
  const base = String(process.env.MEDIA_CDN_BASE || "").replace(/\/$/, "");
  if (!base || !url) return url;
  try {
    const parsed = new URL(url);
    return `${base}${parsed.pathname}`;
  } catch (error) {
    return url;
  }
};

const uploadPhoto = async (couple, { slotId, file } = {}) => {
  const fields = {};
  if (!rules.isKey(slotId)) fields.slotId = "That is not a photo slot.";
  if (!file || !file.data || !file.data.length) fields.file = "Choose a photograph to upload.";
  else if (file.data.length > MAX_UPLOAD_BYTES) fields.file = "That photograph is larger than 12MB.";
  else if (file.mimetype && ALLOWED_MIME.indexOf(String(file.mimetype).toLowerCase()) === -1) {
    fields.file = "That is not a photograph we can put on a website.";
  }
  if (Object.keys(fields).length) throw fail(422, "validation", "That photograph could not be uploaded.", { fields });

  const website = await ensure(couple.weddingId);
  const mediaId = String(new mongoose.Types.ObjectId());
  const base = `couple-website/${String(couple.weddingId)}/${mediaId}`;

  // THE ORIGINAL, byte for byte — this is what a re-crop reads when the couple
  // changes theme, so it is never the thing we transform.
  const originalExt = extensionFor(file.mimetype, file.name);
  const originalUrl = await uploadBufferToS3({
    buffer: file.data,
    key: `${base}-original.${originalExt}`,
    contentType: file.mimetype || "application/octet-stream",
  });

  // THE DERIVATIVE the page actually loads. `withoutEnlargement` so a small
  // photograph is not upscaled into blur; `rotate()` first so a phone's EXIF
  // orientation is honoured rather than sideways on the couple's own website.
  let displayUrl = originalUrl;
  let width = null;
  let height = null;
  try {
    const rendered = await sharp(file.data)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    width = rendered.info.width;
    height = rendered.info.height;
    displayUrl = await uploadBufferToS3({
      buffer: rendered.data,
      key: `${base}.webp`,
      contentType: "image/webp",
    });
  } catch (error) {
    // A format sharp cannot read (an unusual HEIC build, say) must not lose the
    // couple's photograph: the original is already stored and the slot points
    // at it. Degraded, not failed.
    displayUrl = originalUrl;
  }

  const entry = {
    url: cdn(displayUrl),
    mediaId,
    original: cdn(originalUrl),
    ...(width ? { width, height } : {}),
  };
  const photos = { ...(website.photos && typeof website.photos === "object" ? website.photos : {}), [slotId]: entry };

  await Website.updateOne({ weddingId: couple.weddingId }, { $set: { photos } });

  // The contract the brief names — { slotId, mediaId } — plus the URL the
  // builder needs to paint the slot without a second round trip.
  return { ok: true, slotId, mediaId, url: entry.url, original: entry.original, width, height };
};

module.exports = {
  ensure,
  get,
  applySettings,
  saveContent,
  checkSlug,
  publish,
  uploadPhoto,
  isDuplicateKey,
  MAX_UPLOAD_BYTES,
};

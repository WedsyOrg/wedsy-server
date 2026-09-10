/* THE WEDDING WEBSITE — every rule that is a decision rather than a query.
 *
 * PURE. No mongoose, no express, no I/O. Documents in as plain objects,
 * decisions out as plain objects, exactly as CouplePermissions and
 * CoupleRsvpService are — so tests/couple-website-rules.test.js and
 * tests/couple-site-withholding.test.js can run every branch with no database,
 * and so the one place these rules live is readable end to end.
 *
 * FOUR THINGS LIVE HERE, and each is here because it is the control:
 *
 *   1. THE WITHHOLDING RULE (§ 06.4, § 04.10). A password-protected site that
 *      has not been unlocked is not "hidden by CSS" and not "stripped by the
 *      SSR page" — the couple's words, their photographs, their functions and
 *      their gift list ARE NOT PUT IN THE RESPONSE. publicPayload() is the one
 *      function that builds that body and the one function that can withhold,
 *      so there is no second path that could forget.
 *
 *   2. THE PASSWORD NEVER CROSSES THE WIRE. Nothing in this file emits
 *      `privacy.password`; publicPrivacy() and couplePrivacy() both emit
 *      `passwordRequired: boolean` and nothing else. The hash itself is
 *      `select: false` on models/Website too — belt, and braces.
 *
 *   3. THE SLUG. Normalisation, validation and the reserved list. Uniqueness
 *      is NOT here and must never be: it is the unique index on
 *      Website.slug, because a read-then-write check is two couples racing to
 *      the same address (see CoupleWebsiteService.applySettings).
 *
 *   4. THE THEME SWITCH CARRIES THE COUPLE'S WORK (§ 04.10). settingsPatch()
 *      emits `themeId`, `paletteId`, `fontId`, `sections`, `slug` and
 *      `privacy` — and STRUCTURALLY cannot emit `content` or `photos`, because
 *      they are keyed by blockId and slotId and belong to no theme. Switching
 *      tp1 → tp4 therefore cannot touch a word the couple typed. Asserted.
 */

const crypto = require("crypto");
const { THEME_ID, PALETTE_ID, FONT_ID } = require("../utils/coupleEnums");

/* ── the shape of a website ───────────────────────────────────────────────── */

/** The six section switches (§ 04.6). Anything else has nowhere to go. */
const SECTION_KEYS = ["cover", "story", "events", "gallery", "registry", "rsvp"];

/** The keys the public read is allowed to hand a LOCKED visitor, and no others. */
const LOCKED_KEYS = ["slug", "publishedAt", "themeId", "paletteId", "fontId", "privacy", "wedding"];

/** The keys a locked visitor must never receive, in any form. */
const WITHHELD_KEYS = ["content", "photos", "events", "registry", "sections"];

/* ── the slug ─────────────────────────────────────────────────────────────── */

const SLUG_MIN = 3;
const SLUG_MAX = 60;

/**
 * Addresses the couple may not take, because wedsy.in already answers on them
 * or intends to. Kept deliberately short: a reserved list is a promise that the
 * name is unavailable forever, and every word on it is a wedding that cannot
 * have it.
 */
const RESERVED_SLUGS = [
  "site", "sites", "registry", "plan", "api", "admin", "app", "www", "wedsy",
  "login", "signup", "signin", "logout", "account", "settings", "help",
  "support", "about", "contact", "blog", "venues", "venue", "store", "decor",
  "makeup", "payments", "wallet", "guests", "tasks", "public", "static",
  "assets", "images", "img", "css", "js", "robots", "sitemap", "favicon",
];

/**
 * "Ananya & Vikram!" → "ananya-vikram".
 *
 * Lowercase, ASCII, hyphen-separated. Every non-alphanumeric run becomes one
 * hyphen and the ends are trimmed, so a couple pasting their names gets a
 * working address rather than an error message. Diacritics are folded through
 * NFKD so "Mīra" becomes "mira" rather than losing the letter entirely.
 */
const normaliseSlug = (raw) =>
  String(raw === undefined || raw === null ? "" : raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");

/**
 * Is this a slug the couple may have? Returns the shape the slug-check
 * endpoint answers with, so the screen can say WHY rather than just "no".
 *
 * @returns {{ ok: boolean, slug: string, reason: string, message: string }}
 */
const validateSlug = (raw) => {
  const slug = normaliseSlug(raw);
  const answer = (reason, message) => ({ ok: !reason, slug, reason: reason || "", message: message || "" });

  if (!slug) return answer("empty", "Pick an address for your website.");
  if (slug.length < SLUG_MIN) return answer("too_short", `At least ${SLUG_MIN} characters, please.`);
  if (slug.length > SLUG_MAX) return answer("too_long", `Keep it under ${SLUG_MAX} characters.`);
  if (RESERVED_SLUGS.indexOf(slug) !== -1) return answer("reserved", "That address is taken by Wedsy itself — try another.");
  // A 24-hex slug would shadow every /:id route this API has.
  if (/^[0-9a-f]{24}$/.test(slug)) return answer("reserved", "That looks like an id, not a name.");
  return answer("", "");
};

/* ── the settings patch (PUT /wedding/:id/website) ────────────────────────── */

const inEnum = (list, value) => typeof value === "string" && list.indexOf(value) !== -1;

/**
 * Turn the builder's debounced patch into the fields that may be written.
 *
 * THE STRUCTURAL GUARANTEE (§ 04.10): the returned patch has keys drawn from a
 * fixed set that does not include `content` or `photos`. A theme switch posts
 * `{ themeId, paletteId, fontId }` and therefore cannot, by construction,
 * disturb a word or a photograph — those are keyed by blockId and slotId and
 * are written only by PUT /website/content and POST /website/photos.
 *
 * `privacy.password` is returned as PLAINTEXT under the separate key
 * `passwordPlain` — never as `privacy.password` — so the caller cannot write
 * it to the document without hashing it first. `passwordPlain: ""` is the
 * couple clearing the gate and is different from the key being absent.
 *
 * @param {object} body the request body
 * @returns {{ patch: object, fields: object, passwordPlain: (string|undefined), slugRequested: (string|undefined) }}
 */
const settingsPatch = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const patch = {};
  const fields = {};
  let passwordPlain;
  let slugRequested;

  if (b.themeId !== undefined) {
    if (inEnum(THEME_ID, b.themeId)) patch.themeId = b.themeId;
    else fields.themeId = "That is not one of the themes.";
  }
  if (b.paletteId !== undefined) {
    if (inEnum(PALETTE_ID, b.paletteId)) patch.paletteId = b.paletteId;
    else fields.paletteId = "That is not one of the palettes.";
  }
  if (b.fontId !== undefined) {
    if (inEnum(FONT_ID, b.fontId)) patch.fontId = b.fontId;
    else fields.fontId = "That is not one of the typefaces.";
  }

  if (b.sections !== undefined) {
    if (!b.sections || typeof b.sections !== "object" || Array.isArray(b.sections)) {
      fields.sections = "Sections must be a map of switches.";
    } else {
      // Only the six. A seventh has nowhere on the document to go, and
      // silently accepting it would be a switch the couple thinks they set.
      SECTION_KEYS.forEach((key) => {
        if (b.sections[key] !== undefined) patch[`sections.${key}`] = Boolean(b.sections[key]);
      });
    }
  }

  if (b.slug !== undefined) {
    const check = validateSlug(b.slug);
    if (!check.ok) fields.slug = check.message;
    else {
      patch.slug = check.slug;
      slugRequested = check.slug;
    }
  }

  if (b.privacy !== undefined) {
    if (!b.privacy || typeof b.privacy !== "object" || Array.isArray(b.privacy)) {
      fields.privacy = "Privacy must be an object.";
    } else {
      if (b.privacy.linkOnly !== undefined) patch["privacy.linkOnly"] = Boolean(b.privacy.linkOnly);
      if (b.privacy.password !== undefined) {
        const raw = b.privacy.password === null ? "" : b.privacy.password;
        if (typeof raw !== "string") fields.password = "A password is text.";
        else if (raw.length > 200) fields.password = "That password is too long.";
        else if (raw.length && raw.length < 4) fields.password = "At least four characters, please.";
        else passwordPlain = raw;
      }
    }
  }

  // The registry's own presentation lives on this document (§ 05.1) and the
  // builder's privacy panel does not touch it; it is accepted here so the
  // couple's note survives a settings save that carries it.
  if (b.registry !== undefined && b.registry && typeof b.registry === "object" && !Array.isArray(b.registry)) {
    if (b.registry.intro !== undefined) patch["registry.intro"] = String(b.registry.intro).slice(0, 2000);
    if (b.registry.layout === "grid" || b.registry.layout === "list") patch["registry.layout"] = b.registry.layout;
  }

  return { patch, fields, passwordPlain, slugRequested };
};

/* ── words and photographs (PUT /wedding/:id/website/content) ─────────────── */

const MAX_BLOCKS = 200;
const MAX_BLOCK_CHARS = 4000;
const MAX_SLOTS = 60;

/** A blockId or a slotId: the theme layer's own spelling, and nothing exotic. */
const isKey = (key) => typeof key === "string" && /^[a-z0-9][a-z0-9._-]{0,60}$/i.test(key);

/**
 * Merge a debounced content write.
 *
 * TWO SHAPES, because the client sends one and the brief names the other:
 *
 *   { content: {...}, photos: {...} }   the builder's actual save. The maps are
 *                                       REPLACED, because the builder holds the
 *                                       whole map and `delete next[slotId]` is
 *                                       how a photograph is cleared — a merge
 *                                       would make clearing impossible.
 *   { "cover.names": "Ananya & Vikram" } a bare blockId map. MERGED, and a null
 *                                       or empty value DELETES that block, so a
 *                                       partial write can still undo itself.
 *
 * Values are strings. A block longer than MAX_BLOCK_CHARS is a paste accident,
 * not a wedding website, and is refused rather than truncated silently.
 *
 * @returns {{ ok:boolean, fields?:object, content?:object, photos?:object, touched:string[] }}
 */
const mergeContent = (existing, body) => {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const fields = {};
  const touched = [];

  const currentContent = existing && typeof existing.content === "object" && existing.content ? existing.content : {};
  const currentPhotos = existing && typeof existing.photos === "object" && existing.photos ? existing.photos : {};

  const envelope = b.content !== undefined || b.photos !== undefined;

  let content = { ...currentContent };
  let photos = { ...currentPhotos };

  const cleanContent = (map) => {
    const out = {};
    Object.keys(map || {}).forEach((key) => {
      if (!isKey(key)) { fields[key] = "That is not a block."; return; }
      const value = map[key];
      if (value === null || value === undefined || value === "") return; // absent, not empty
      if (typeof value !== "string") { fields[key] = "A block holds text."; return; }
      if (value.length > MAX_BLOCK_CHARS) { fields[key] = "That is longer than a wedding website block."; return; }
      out[key] = value;
      touched.push(key);
    });
    return out;
  };

  const cleanPhotos = (map) => {
    const out = {};
    Object.keys(map || {}).forEach((slot) => {
      if (!isKey(slot)) { fields[slot] = "That is not a photo slot."; return; }
      const value = map[slot];
      if (value === null || value === undefined || value === "") return;
      // A stored slot is either the URL string the builder sets, or the
      // { url, mediaId } record POST /website/photos writes. Both are what the
      // client's photoPath() already reads (`string | {url}`).
      if (typeof value === "string") { out[slot] = value; touched.push(slot); return; }
      if (typeof value === "object" && typeof value.url === "string" && value.url) {
        out[slot] = { url: value.url, ...(value.mediaId ? { mediaId: String(value.mediaId) } : {}), ...(value.original ? { original: String(value.original) } : {}) };
        touched.push(slot);
        return;
      }
      fields[slot] = "A photo slot holds a picture.";
    });
    return out;
  };

  if (envelope) {
    if (b.content !== undefined) {
      if (!b.content || typeof b.content !== "object" || Array.isArray(b.content)) fields.content = "Content must be a map keyed by block.";
      else content = cleanContent(b.content);
    }
    if (b.photos !== undefined) {
      if (!b.photos || typeof b.photos !== "object" || Array.isArray(b.photos)) fields.photos = "Photos must be a map keyed by slot.";
      else photos = cleanPhotos(b.photos);
    }
  } else {
    // The bare { blockId: value } form. Merge, and let an explicit null delete.
    Object.keys(b).forEach((key) => {
      if (!isKey(key)) { fields[key] = "That is not a block."; return; }
      const value = b[key];
      if (value === null || value === "") { delete content[key]; touched.push(key); return; }
      if (typeof value !== "string") { fields[key] = "A block holds text."; return; }
      if (value.length > MAX_BLOCK_CHARS) { fields[key] = "That is longer than a wedding website block."; return; }
      content[key] = value;
      touched.push(key);
    });
  }

  if (Object.keys(content).length > MAX_BLOCKS) fields.content = "That is more blocks than any theme has.";
  if (Object.keys(photos).length > MAX_SLOTS) fields.photos = "That is more photographs than any theme shows.";

  if (Object.keys(fields).length) return { ok: false, fields, touched };
  return { ok: true, content, photos, touched };
};

/* ── privacy, both sides of the wire ──────────────────────────────────────── */

/** Is this website behind a password? A stored bcrypt hash, or nothing. */
const isGated = (website) => Boolean(website && website.privacy && String(website.privacy.password || "").length);

/**
 * What a guest is told about privacy. `passwordRequired` and `linkOnly` — and
 * NOT the hash, in any form. There is no branch of this function that reads
 * `privacy.password` for anything but its length.
 */
const publicPrivacy = (website) => ({
  linkOnly: Boolean(website && website.privacy && website.privacy.linkOnly),
  passwordRequired: isGated(website),
});

/** What the couple is told. The same two booleans: they set it, they do not need it back. */
const couplePrivacy = publicPrivacy;

/* ── the public payload, and the withholding rule ─────────────────────────── */

/** An Event day → the public function card. NO expectedGuests: that is the couple's number. */
const publicDay = (day, keyOf) => ({
  id: String((day && day._id) || ""),
  key: typeof keyOf === "function" ? keyOf(day && day.name) : "",
  name: (day && day.name) || "",
  date: (day && day.date) || "",
  startTime: (day && day.time) || "",
  venue: (day && day.venue) || "",
});

/** A partner, as a stranger may see them: a name and which of the two they are. */
const publicPartner = (partner, index) => ({
  name: (partner && partner.name) || "",
  role: (partner && partner.role) || (index === 0 ? "bride" : "groom"),
});

/** The partners of a wedding, falling back to the CRM's two names. */
const publicPartners = (event) => {
  const partners = (event && event.coupleApp && event.coupleApp.partners) || [];
  if (partners.length) return partners.map(publicPartner);
  return [
    { name: (event && event.brideName) || "", role: "bride" },
    { name: (event && event.groomName) || "", role: "groom" },
  ].filter((partner) => partner.name);
};

/**
 * GET /site/:slug — the whole body, and the ONE place it can be withheld.
 *
 * ── THE RULE (§ 06.4, § 04.10, and the ⛏ STUB in lib/plan/api-public.js) ──
 * A site that is password-protected and has not proved an unlock, and a site
 * that is not published at all, are handed EXACTLY the seven keys a gate needs
 * to be drawn in the couple's own palette under their own names:
 *
 *     slug, publishedAt, themeId, paletteId, fontId, privacy, wedding.partners
 *
 * `content`, `photos`, `events`, `registry` and `sections` are not emptied,
 * not nulled and not stripped afterwards — they are never put in the object.
 * The SSR page in wedsy-user does the same with its props; that is a
 * convenience. THIS is the control.
 *
 * An UNPUBLISHED site is withheld for the same reason: nothing public exists
 * at that address yet, so a draft the couple has not sent out is not a draft a
 * stranger may read. The client renders its own "not out yet" state from
 * `publishedAt: null`, which is why this returns a body at all rather than a
 * 404 — an unknown slug is the 404, and the two states are different.
 *
 * @param {object}   opts.website   the Website document (plain)
 * @param {object}   opts.event     the Event document (plain)
 * @param {object[]} [opts.registry] shaped registry rows, when the section is on
 * @param {boolean}  [opts.unlocked] has this request proved the password?
 * @param {Function} [opts.keyOf]   dayKey, injected so the key rule stays single-sourced
 */
const publicPayload = ({ website, event, registry = [], unlocked = false, keyOf } = {}) => {
  const site = website || {};
  const published = Boolean(site.publishedAt);
  const gated = isGated(site);
  const locked = gated && !unlocked;

  const shell = {
    slug: site.slug || "",
    publishedAt: published ? site.publishedAt : null,
    themeId: site.themeId || "tp1",
    paletteId: site.paletteId || "p1",
    fontId: site.fontId || "f1",
    privacy: publicPrivacy(site),
    wedding: { partners: publicPartners(event) },
  };

  // THE WITHHOLDING. Return the shell and nothing else — no `content` key, no
  // `photos` key, no `events` key, no `registry` key, no `sections` key.
  if (locked || !published) return shell;

  const sections = site.sections || {};
  return {
    ...shell,
    sections: {
      cover: sections.cover !== false,
      story: sections.story !== false,
      events: sections.events !== false,
      gallery: sections.gallery !== false,
      registry: Boolean(sections.registry),
      rsvp: sections.rsvp !== false,
    },
    content: site.content && typeof site.content === "object" ? site.content : {},
    photos: site.photos && typeof site.photos === "object" ? site.photos : {},
    wedding: {
      city: (event && event.coupleApp && event.coupleApp.city) || "",
      weddingDate: (event && event.eventDate) || "",
      muhurthamTime: (event && event.coupleApp && event.coupleApp.muhurthamTime) || "",
      coverPhoto: (event && event.coupleApp && event.coupleApp.coverPhoto) || "",
      partners: shell.wedding.partners,
    },
    events: ((event && event.eventDays) || []).map((day) => publicDay(day, keyOf)),
    registry: Boolean(sections.registry) && Array.isArray(registry) ? registry : [],
  };
};

/** What the couple's own builder reads back. The hash is not in it. */
const couplePayload = (website) => {
  const site = website || {};
  const sections = site.sections || {};
  return {
    slug: site.slug || "",
    publishedAt: site.publishedAt || null,
    themeId: site.themeId || "tp1",
    paletteId: site.paletteId || "p1",
    fontId: site.fontId || "f1",
    sections: {
      cover: sections.cover !== false,
      story: sections.story !== false,
      events: sections.events !== false,
      gallery: sections.gallery !== false,
      registry: Boolean(sections.registry),
      rsvp: sections.rsvp !== false,
    },
    content: site.content && typeof site.content === "object" ? site.content : {},
    photos: site.photos && typeof site.photos === "object" ? site.photos : {},
    privacy: couplePrivacy(site),
    registry: {
      intro: (site.registry && site.registry.intro) || "",
      layout: (site.registry && site.registry.layout) || "grid",
    },
  };
};

/* ── the unlock token ─────────────────────────────────────────────────────── */

/**
 * POST /site/:slug/unlock proves the password ONCE; GET /site/:slug has to be
 * told about it on every later request, and a guest has no account to remember
 * it in. So the unlock is a short signed token: `<expiry>.<hmac(slug.expiry)>`.
 *
 * It is not the password and reveals nothing about it, it names the slug it
 * was minted for (unlocking one wedding never unlocks another), and it expires.
 * wedsy-user's lib/plan/site-gate.js mints an equivalent token of its own for
 * its httpOnly cookie; this one is the server's, because the server is what
 * decides what to send.
 *
 * THE SECRET IS INJECTED, never read from the environment in this file: a pure
 * function that reads process.env is a pure function you cannot test. See
 * CouplePublicSiteService.unlockSecret() for where it comes from — and note
 * that an unset secret verifies NOTHING, which fails closed.
 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days: a guest opening the link twice is not asked twice

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const signUnlock = (secret, payload) => b64url(crypto.createHmac("sha256", String(secret)).update(String(payload)).digest());

/** Constant-time compare that does not throw on a length mismatch. */
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // burn the same work, so a wrong length is not measurably faster
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
};

const mintUnlockToken = (slug, secret, now = Date.now(), ttl = TOKEN_TTL_MS) => {
  if (!secret) return "";
  const exp = Number(now) + Number(ttl);
  return `${exp}.${signUnlock(secret, `${slug}.${exp}`)}`;
};

const verifyUnlockToken = (slug, token, secret, now = Date.now()) => {
  // No secret configured means no token can ever verify. Fail closed: a gated
  // site with a misconfigured deploy stays gated rather than opening to all.
  if (!secret) return false;
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Number(now)) return false;
  return safeEqual(token.slice(dot + 1), signUnlock(secret, `${slug}.${exp}`));
};

/** One cookie per site, so unlocking one wedding never unlocks another. */
const unlockCookieName = (slug) => `wedsy_unlock_${String(slug).replace(/[^A-Za-z0-9_-]/g, "")}`;

/** Read one cookie out of a raw Cookie header, without adding a dependency. */
const readCookie = (header, name) => {
  if (!header) return null;
  const parts = String(header).split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const eq = parts[i].indexOf("=");
    if (eq < 0) continue;
    if (parts[i].slice(0, eq).trim() !== name) continue;
    const raw = parts[i].slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch (error) { return raw; }
  }
  return null;
};

/**
 * Where an unlock proof may arrive. Three doors, because three callers exist:
 * an SSR render forwarding what it holds (header), a link a guest was given
 * (query), and a browser that has been here before (cookie).
 *
 * PURE over a request-ish `{ headers, query }`, so the test drives it directly.
 */
const unlockTokenFrom = (req, slug) => {
  const headers = (req && req.headers) || {};
  const query = (req && req.query) || {};
  const header = headers["x-site-unlock"] || headers["X-Site-Unlock"];
  if (header) return String(header);
  if (query.unlock) return String(query.unlock);
  return readCookie(headers.cookie, unlockCookieName(slug)) || "";
};

/** The Set-Cookie a successful unlock returns. httpOnly: a script never reads it. */
const unlockCookieHeader = (slug, token, { secure = true, ttl = TOKEN_TTL_MS } = {}) =>
  [
    `${unlockCookieName(slug)}=${token}`,
    "Path=/",
    `Max-Age=${Math.floor(ttl / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

/* ── refusals ─────────────────────────────────────────────────────────────── */

const notFound = () => ({ error: "not_found", message: "We could not find that wedding website." });
const validationBody = (fields) => ({ error: "validation", fields });
const slugTaken = (slug) => ({ error: "slug_taken", slug, message: "Another couple has that address. Try another." });
const noSlug = () => ({ error: "no_slug", message: "Choose your website address before you publish." });
const rateLimited = (retryAfter) => ({ error: "rate_limited", retryAfter: retryAfter || null, message: "That is a few too many tries. Please wait a moment." });

module.exports = {
  SECTION_KEYS,
  LOCKED_KEYS,
  WITHHELD_KEYS,
  RESERVED_SLUGS,
  SLUG_MIN,
  SLUG_MAX,
  TOKEN_TTL_MS,
  normaliseSlug,
  validateSlug,
  settingsPatch,
  mergeContent,
  isKey,
  isGated,
  publicPrivacy,
  couplePrivacy,
  publicDay,
  publicPartners,
  publicPayload,
  couplePayload,
  mintUnlockToken,
  verifyUnlockToken,
  unlockCookieName,
  unlockCookieHeader,
  unlockTokenFrom,
  readCookie,
  notFound,
  validationBody,
  slugTaken,
  noSlug,
  rateLimited,
};

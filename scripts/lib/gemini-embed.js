// Shared Gemini image-embedding helpers for the retrieval-layer scripts
// (embed-catalogue.js + query-embeddings.js). Kept in one place so the catalogue
// and the query image are embedded IDENTICALLY — any drift here silently breaks
// retrieval. Not wired into the server; used only by the manual scripts.
//
// Model decision (spec, 28 Jul): Gemini Embedding 2 @ 768 dims, paid tier.
// Called over the REST API with native fetch (Node 18+) so no SDK dependency.
// Model / dimensions / max edge are env-overridable — re-embedding with another
// model is a ~1-hour, sub-$1 job, not a migration.

const sharp = require("sharp");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";
const DIMENSIONS = Number(process.env.GEMINI_EMBED_DIM) || 768;
const MAX_EDGE = Number(process.env.EMBED_MAX_EDGE) || 1024; // longest-edge downscale cap
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(30000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300);

// ── image IO + preprocessing ─────────────────────────────────────────────────
// Fetch bytes from an S3 (or any http) URL. Retries on network / 429 / 5xx.
async function fetchImageBuffer(url, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: false });
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      const retryable =
        e.retryable ||
        e.name === "AbortError" ||
        /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(e.message || "");
      if (attempt < retries && retryable) {
        await sleep(backoff(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Preprocess per the spec: correct EXIF orientation, preserve aspect ratio (no
// crop, no forced square), downscale only if larger than MAX_EDGE, re-encode
// JPEG. NO white-balance / colour normalisation (erases floral/material cues).
async function preprocessToBase64(buffer) {
  const out = await sharp(buffer, { failOn: "none" })
    .rotate() // applies EXIF orientation, then strips the tag
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return out.toString("base64");
}

// ── vector math ──────────────────────────────────────────────────────────────
// Pre-normalise to unit length so retrieval is a plain dot product (= cosine).
function unitNormalize(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((x) => x / norm);
}
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ── Gemini REST ──────────────────────────────────────────────────────────────
async function geminiCall(endpoint, body, { retries = 5 } = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set (export it or add to .env)");
  const url = `${API_BASE}/models/${endpoint}?key=${GEMINI_API_KEY}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        const txt = await res.text().catch(() => "");
        throw Object.assign(new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`), {
          retryable: true,
          status: res.status,
        });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw Object.assign(new Error(`Gemini ${res.status}: ${txt.slice(0, 300)}`), {
          retryable: false,
          status: res.status,
        });
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const retryable =
        e.retryable || e.name === "AbortError" || /fetch failed|network|ECONN/i.test(e.message || "");
      if (attempt < retries && retryable) {
        await sleep(backoff(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const imagePart = (base64) => ({ inlineData: { mimeType: "image/jpeg", data: base64 } });

// Embed a single preprocessed image → raw (un-normalised) vector.
async function embedOne(base64, opts = {}) {
  const body = { content: { parts: [imagePart(base64)] }, outputDimensionality: DIMENSIONS };
  const res = await geminiCall(`${MODEL}:embedContent`, body, opts);
  const values = res && res.embedding && res.embedding.values;
  if (!Array.isArray(values)) throw new Error("Gemini response missing embedding.values");
  return values;
}

// Batch-embed several preprocessed images in one request (order preserved).
async function embedBatch(base64List, opts = {}) {
  const body = {
    requests: base64List.map((b64) => ({
      model: `models/${MODEL}`,
      content: { parts: [imagePart(b64)] },
      outputDimensionality: DIMENSIONS,
    })),
  };
  const res = await geminiCall(`${MODEL}:batchEmbedContents`, body, opts);
  const embs = res && res.embeddings;
  if (!Array.isArray(embs) || embs.length !== base64List.length) {
    throw new Error(`batch returned ${embs ? embs.length : "?"} embeddings for ${base64List.length} inputs`);
  }
  return embs.map((e) => e.values);
}

module.exports = {
  MODEL,
  DIMENSIONS,
  MAX_EDGE,
  fetchImageBuffer,
  preprocessToBase64,
  unitNormalize,
  dot,
  embedOne,
  embedBatch,
};

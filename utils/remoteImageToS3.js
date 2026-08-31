const sharp = require("sharp");
const { uploadBufferToS3 } = require("./s3Upload");

// ── Server-side image adoption ───────────────────────────────────────────────
// The extension supplies a Pinterest URL; the SERVER fetches it and stores our
// own asset, so the catalogue never depends on a pinimg URL continuing to
// resolve. Same pattern WhatsAppMediaService already uses for Meta media:
//   fetch(remote) → Buffer → uploadBufferToS3 → our URL.
// The bulk-upload intake enters one step later: the bytes arrive by multipart,
// so storeUploadedImage skips the fetch and joins at the same normalise+store
// tail — one JPEG pipeline and one key scheme for both origins.
//
// Normalised to JPEG for the same reason controllers/file.js does it (HEIC /
// WebP / AVIF are not universally renderable).

const MAX_BYTES = Number(process.env.A2S_IMAGE_MAX_BYTES) || 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.A2S_IMAGE_TIMEOUT_MS) || 15000;

// Pinterest's CDN is content-negotiated; a browser-ish UA avoids the occasional
// 403 on a bare fetch.
const UA =
  "Mozilla/5.0 (compatible; WedsyBot/1.0; +https://wedsy.in) AppleWebKit/537.36";

const fetchRemoteImage = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" },
    });
  } catch (e) {
    throw new Error(
      e.name === "AbortError"
        ? `image fetch timed out after ${FETCH_TIMEOUT_MS}ms`
        : `image fetch failed: ${e.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`image fetch failed (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType && !/^image\//i.test(contentType)) {
    throw new Error(`source URL is not an image (content-type: ${contentType})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("image fetch returned an empty body");
  if (buf.length > MAX_BYTES) {
    throw new Error(`image is ${Math.round(buf.length / 1024)}KB — over the ${Math.round(MAX_BYTES / 1024)}KB limit`);
  }
  return buf;
};

// The shared tail: normalise whatever bytes we hold to JPEG and store under the
// one key scheme. Split out so the remote-fetch and staff-upload origins cannot
// drift — a draft's storedImage must look the same downstream either way.
const normalizeAndStore = async (raw, { path, id }) => {
  let jpeg;
  try {
    jpeg = await sharp(raw, { failOn: "none" }).rotate().jpeg({ quality: 90 }).toBuffer();
  } catch (e) {
    throw new Error(`could not decode the source image: ${e.message}`);
  }

  const storedUrl = await uploadBufferToS3({
    buffer: jpeg,
    key: `${path}/${id}.jpg`,
    contentType: "image/jpeg",
  });
  return { url: storedUrl, buffer: jpeg };
};

// Fetch a remote image and store it as OUR S3 asset. Returns { url, buffer },
// where `buffer` is the normalised JPEG (reused for the vision calls, so the
// image is fetched exactly once per A2S click).
const storeRemoteImage = async ({ url, path = "decor-drafts", id }) => {
  if (!url) throw new Error("storeRemoteImage: url is required");
  if (!id) throw new Error("storeRemoteImage: id is required");
  return normalizeAndStore(await fetchRemoteImage(url), { path, id });
};

// Staff-uploaded bytes (multipart) → OUR S3 asset. No fetch — the bytes are in
// hand. The size cap is enforced here as well as at the multipart layer: this
// util is the last line before S3, and a caller that forgot to configure the
// route limit must not become a way past it.
const storeUploadedImage = async ({ buffer, path = "decor-drafts", id }) => {
  if (!buffer || !buffer.length) throw new Error("storeUploadedImage: buffer is required");
  if (!id) throw new Error("storeUploadedImage: id is required");
  if (buffer.length > MAX_BYTES) {
    throw new Error(`image is ${Math.round(buffer.length / 1024)}KB — over the ${Math.round(MAX_BYTES / 1024)}KB limit`);
  }
  return normalizeAndStore(buffer, { path, id });
};

// Downscale for the vision calls — same budget as the demo path (max 800px
// longest edge), so token cost and latency match the calibrated behaviour.
const DEMO_MAX_EDGE = Number(process.env.DEMO_IMAGE_MAX_EDGE) || 800;
const toAnalysisBase64 = async (buffer) => {
  const out = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({ width: DEMO_MAX_EDGE, height: DEMO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return out.toString("base64");
};

module.exports = { storeRemoteImage, storeUploadedImage, fetchRemoteImage, toAnalysisBase64 };

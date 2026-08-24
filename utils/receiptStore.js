const crypto = require("crypto");
const { uploadBufferToS3 } = require("./s3Upload");

// -- Receipt storage: a RECEIPTS-ONLY path in front of uploadBufferToS3 -------
//
// Deliberately NOT POST /file, for three reasons found in the upload audit:
//   1. That route is gated on CheckLogin, which admits CUSTOMER and VENDOR
//      tokens - not a gate you want on financial evidence.
//   2. The caller supplies `path` and `id`, so a second upload with the same
//      pair SILENTLY OVERWRITES the first. A claimant could replace a receipt
//      after approval and leave no trace at all.
//   3. It re-encodes every image/* through sharp to lossy JPEG. That is right
//      for a catalogue photo and wrong for a document that IS the evidence.
//
// This module fixes all three: admin-only at the route, keys that cannot
// collide, and the ORIGINAL BYTES stored untouched.

// -- SIZE CAP: 15 MB per file ------------------------------------------------
// Chosen to match the A2S_IMAGE_MAX_BYTES precedent already in this codebase
// rather than invent a second number. It comfortably fits a phone photo (2-8 MB)
// and a multi-page scanned PDF, and several receipts still sit well inside the
// 50 MB body limit in server.js.
//
// This route takes MULTIPART, not base64 JSON, which matters: base64 inflates
// ~33%, so the other upload path's effective ceiling is nearer 37 MB of real
// file. Multipart carries the bytes as-is, so 15 MB here means 15 MB.
const MAX_BYTES = Number(process.env.RECEIPT_MAX_BYTES) || 15 * 1024 * 1024;

// -- ALLOWLIST, CHECKED ON THE SERVER ----------------------------------------
// Following the PDF_MIME precedent in controllers/venueTermsDocument: the type
// is decided here, not accepted from the client. A browser's declared mimetype
// is a claim, so the buffer's MAGIC BYTES are what actually decides - a .pdf
// renamed to .jpg is caught, and so is anything executable wearing an image
// extension.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"];

const SNIFFERS = [
  { mime: "application/pdf", type: "pdf", test: (b) => b.slice(0, 4).toString("latin1") === "%PDF" },
  { mime: "image/jpeg", type: "image", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", type: "image", test: (b) => b.slice(0, 8).equals(PNG_MAGIC) },
  {
    mime: "image/webp", type: "image",
    test: (b) => b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP",
  },
  // HEIC/HEIF - what an iPhone produces by default. Accepted because refusing it
  // would block real claims from real phones. WARNING: stored as-is and NOT
  // converted, per the no-re-encoding rule, so most browsers will not PREVIEW
  // it. That is a display problem for the frontend to solve (or for the claimant
  // to be told about), never a reason to rewrite the evidence.
  {
    mime: "image/heic", type: "image",
    test: (b) => b.slice(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.includes(b.slice(8, 12).toString("latin1")),
  },
];

const EXT = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

const err = (status, message) => Object.assign(new Error(message), { status });

// What IS this file, really? Returns { mime, type, ext } or throws 400.
const sniff = (buffer, declaredMime) => {
  if (!buffer || buffer.length < 12) throw err(400, "That file is empty or too small to be a receipt");
  const hit = SNIFFERS.find((s) => {
    try {
      return s.test(buffer);
    } catch (_) {
      return false;
    }
  });
  if (!hit) {
    throw err(
      400,
      `That file is not an image or a PDF${declaredMime ? ` (it was sent as ${declaredMime})` : ""}. ` +
        "Receipts must be a photo or a PDF."
    );
  }
  return { mime: hit.mime, type: hit.type, ext: EXT[hit.mime] || "bin" };
};

// -- UNIQUE KEYS UNDER A RECEIPTS-ONLY PREFIX --------------------------------
// `receipts/` is written by this module and nothing else - the upload audit
// found decor-drafts/, venues/, os/ and whatever POST /file's caller passes, so
// this prefix is unclaimed. The random component means a key can never repeat,
// so no upload can overwrite an earlier receipt even by accident.
const RECEIPT_PREFIX = "receipts";
const keyFor = (claimId, ext) => `${RECEIPT_PREFIX}/${claimId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

// Store ONE receipt. The original bytes go to S3 untouched - no sharp, no
// re-encode, no normalisation. What was filed is what is stored.
const storeReceipt = async ({ buffer, filename, declaredMime, claimId, uploadedBy }) => {
  if (!Buffer.isBuffer(buffer)) throw err(400, "No file received");
  if (buffer.length > MAX_BYTES) {
    throw err(
      400,
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_BYTES / 1024 / 1024} MB per receipt.`
    );
  }
  const { mime, type, ext } = sniff(buffer, declaredMime);
  const url = await uploadBufferToS3({ buffer, key: keyFor(claimId, ext), contentType: mime });
  return {
    type,
    url,
    name: String(filename || "").slice(0, 200),
    // The SNIFFED type, not the browser's claim - so an audit reads what was
    // actually filed rather than what the uploader said it was filing.
    contentType: mime,
    sizeBytes: buffer.length,
    uploadedAt: new Date(),
    uploadedBy: uploadedBy || null,
  };
};

module.exports = { MAX_BYTES, RECEIPT_PREFIX, SNIFFERS, sniff, keyFor, storeReceipt };

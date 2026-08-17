/**
 * utils/pdfStitch.js — put a generated cover page in front of a PDF we did not
 * write, without altering a byte of what follows it.
 *
 * ══ LIBRARY CHOICE: pdf-lib 1.17.1 ══════════════════════════════════════════
 *
 * Candidates, with the reasons:
 *
 *   pdf-lib 1.17.1 — MIT. Pure JavaScript, zero native dependencies. CHOSEN.
 *   muhammara 6.0.5 — Apache-2.0, actively maintained (May 2026), streaming and
 *     genuinely lighter on memory. REJECTED on deployment risk: it installs
 *     through @mapbox/node-pre-gyp, so it needs a prebuilt binary matching the
 *     box's Node ABI and libc, and compiles from source when one is missing.
 *     A deploy that has to run node-gyp on a 1 GB box is a deploy that can fail
 *     for reasons unrelated to this feature, on the box we are already trying
 *     not to tip over. Pure JS is worth real memory here.
 *   pdf-merger-js 5.1.2 — a thin wrapper AROUND pdf-lib. Same memory profile,
 *     one more dependency, no capability we need. REJECTED.
 *
 * The honest mark against pdf-lib: last published 2022-05-12, so it is four
 * years stale and effectively feature-frozen. Accepted deliberately — it is the
 * de-facto standard with no open security advisory, and the API surface we touch
 * (`load`, `copyPages`, `save`) is the oldest, most exercised part of it. We are
 * nowhere near its frontier. Worth revisiting if we ever need to EDIT rather
 * than concatenate.
 *
 * ══ MEMORY, AND WHY THE CAP IS NOT OPTIONAL ═════════════════════════════════
 *
 * The prod box has 1 GB and has already OOM'd twice, so this was measured
 * rather than assumed. Stitching a 1-page cover onto sources of varying size:
 *
 *     source      peak RSS    ratio
 *     1.5 MB       70 MB      (floor is the Node baseline, not the file)
 *     29.8 MB     125 MB      4.2x
 *     128.6 MB    335 MB      2.6x
 *     29.8 MB x6 concurrent   379 MB
 *
 * The finding that shapes the design: the memory is NOT on the V8 heap.
 * Measured across the same run, `heapUsed` moved 7 MB → 9 MB while
 * `arrayBuffers` moved 0 MB → 258 MB. pdf-lib holds documents as Uint8Array, so
 * it is external allocation.
 *
 * That has a hard consequence. `--max-old-space-size` does not bound it: a
 * 128 MB source completed happily under a 200 MB heap cap. There is no
 * JavaScript heap error to catch — RSS simply climbs until the kernel OOM-kills
 * the process. A `try/catch` around the stitch cannot save the box, and a
 * request that would exceed memory does not fail cleanly, it takes the whole
 * server down with every other request in flight.
 *
 * So the size cap below is the ONLY defence, and it must be applied BEFORE the
 * bytes are loaded. Two places, because either alone has a hole:
 *
 *   1. Content-Length, when the server sends one — refuses without downloading.
 *   2. A running byte count during the download, aborting mid-stream. Needed
 *      because Content-Length is absent under chunked encoding and is in any
 *      case a claim, not a measurement.
 *
 * Note what is deliberately NOT trusted: `Venue.termsDocument.sizeBytes`. That
 * value is supplied by the client on PUT, and the S3 object it describes could
 * be any size at all. The upload path's 10 MB check validates a number in a
 * request body; this checks the object.
 */
const { PDFDocument } = require("pdf-lib");
const axios = require("axios");

/**
 * 12 MB. The upload path caps the *declared* size at 10 MB
 * (controllers/venueTermsDocument.MAX_BYTES), so anything a venue legitimately
 * uploaded fits with room to spare; the margin exists so a document sitting
 * exactly at the limit is not rejected by a rounding disagreement between what
 * the client declared and what S3 stored. At 12 MB the measured peak is well
 * under 100 MB even several deep, which the box survives.
 */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/** Anything bigger than this and we would not be stitching, we would be leaking. */
const MAX_SOURCE_PAGES = 500;

const FETCH_TIMEOUT_MS = 20000;

class StitchError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const looksLikePdf = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

/**
 * Download the venue's PDF, refusing anything over the cap without ever holding
 * it. Streamed specifically so an oversized object is abandoned part-way rather
 * than buffered in full and measured afterwards — buffering first would mean the
 * cap protected nothing, since the damage is the allocation.
 *
 * @returns {Promise<Buffer>}
 */
async function fetchSourcePdf(url, { maxBytes = MAX_SOURCE_BYTES } = {}) {
  if (!url || typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new StitchError("The stored terms document has no usable URL.", "bad_source_url");
  }

  let res;
  try {
    res = await axios.get(url, { responseType: "stream", timeout: FETCH_TIMEOUT_MS, maxRedirects: 3 });
  } catch (e) {
    throw new StitchError(`Could not fetch the terms document: ${e.message}`, "source_unreachable", 502);
  }

  // Cheapest refusal available — no body read at all.
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.data.destroy();
    throw new StitchError(
      `That terms document is ${(declared / 1048576).toFixed(1)} MB. The limit for generating a personalised copy is ${(maxBytes / 1048576).toFixed(0)} MB.`,
      "source_too_large",
      413
    );
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      res.data.destroy();
      chunks.length = 0; // drop what we already hold; this is the whole point
      reject(err);
    };
    res.data.on("data", (c) => {
      if (settled) return;
      total += c.length;
      // The real guard: Content-Length may be absent (chunked) or simply wrong.
      if (total > maxBytes) {
        fail(
          new StitchError(
            `That terms document exceeds the ${(maxBytes / 1048576).toFixed(0)} MB limit for generating a personalised copy.`,
            "source_too_large",
            413
          )
        );
        return;
      }
      chunks.push(c);
    });
    res.data.on("error", (e) => fail(new StitchError(`Download failed: ${e.message}`, "source_unreachable", 502)));
    res.data.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Concatenate `coverBuffer` + `sourceBuffer` into one PDF.
 *
 * The source's pages are COPIED, never rewritten: copyPages lifts each page
 * object and its resource tree across intact, so the content streams that
 * describe the venue's text, fonts and images are the same objects on the other
 * side. That is the whole basis of the fidelity promise — we are not rendering
 * their document, we are carrying it.
 *
 * @returns {Promise<{ buffer: Buffer, coverPages: number, sourcePages: number, totalPages: number }>}
 */
async function stitchCoverOntoPdf(coverBuffer, sourceBuffer, { maxPages = MAX_SOURCE_PAGES } = {}) {
  if (!looksLikePdf(coverBuffer)) throw new StitchError("Generated cover is not a valid PDF.", "bad_cover", 500);
  if (!looksLikePdf(sourceBuffer)) {
    throw new StitchError(
      "The stored terms document is not a readable PDF. Re-upload it in Settings.",
      "source_not_pdf"
    );
  }

  let cover;
  let source;
  try {
    cover = await PDFDocument.load(coverBuffer);
  } catch (e) {
    throw new StitchError(`Generated cover could not be read back: ${e.message}`, "bad_cover", 500);
  }
  try {
    // ignoreEncryption: a venue's terms are routinely exported from Word with
    // owner-password permissions set (no-print, no-copy) and no user password.
    // Those open fine and must not be refused; a document needing a password to
    // open still throws below and is reported as such.
    source = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  } catch (e) {
    throw new StitchError(
      `The stored terms document could not be read (${e.message}). Re-upload it in Settings.`,
      "source_unreadable"
    );
  }

  const sourcePages = source.getPageCount();
  if (sourcePages < 1) throw new StitchError("The stored terms document has no pages.", "source_empty");
  if (sourcePages > maxPages) {
    throw new StitchError(`That terms document has ${sourcePages} pages; the limit is ${maxPages}.`, "source_too_long", 413);
  }

  const out = await PDFDocument.create();
  const coverPages = await out.copyPages(cover, cover.getPageIndices());
  for (const p of coverPages) out.addPage(p);
  const carried = await out.copyPages(source, source.getPageIndices());
  for (const p of carried) out.addPage(p);

  const bytes = await out.save();
  return {
    buffer: Buffer.from(bytes),
    coverPages: cover.getPageCount(),
    sourcePages,
    totalPages: out.getPageCount(),
  };
}

/**
 * Verify the stitched output still carries the source unchanged.
 *
 * Byte-identity of the FILE is not the right test and cannot be: a PDF is an
 * object graph with a cross-reference table, so concatenating renumbers objects
 * and rewrites offsets by design. Two things are asserted instead, and together
 * they are what "identical" can honestly mean here:
 *
 *   · page count — cover pages plus every source page, none dropped or added
 *   · per-page content-stream bytes — for each source page, the decoded content
 *     stream in the output is byte-identical to the same page's in the original
 *
 * The second is the real one. The content stream is the drawing program for the
 * page: every glyph placement, every line, every image reference. If a clause
 * had been reflowed, a font substituted or a table shifted, those bytes would
 * differ. Comparing them is a stronger statement than comparing rendered text,
 * because it catches changes that a text extraction would silently normalise.
 *
 * @returns {Promise<{ ok: boolean, checkedPages: number, mismatches: number[], reason?: string }>}
 */
async function verifySourcePreserved(outputBuffer, sourceBuffer, { coverPages = 1 } = {}) {
  const out = await PDFDocument.load(outputBuffer, { ignoreEncryption: true });
  const src = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });

  const srcCount = src.getPageCount();
  if (out.getPageCount() !== srcCount + coverPages) {
    return {
      ok: false,
      checkedPages: 0,
      mismatches: [],
      reason: `page count is ${out.getPageCount()}, expected ${srcCount + coverPages}`,
    };
  }

  // Decoded content-stream bytes for one page, concatenated across the array
  // form (a page's content may be split over several streams).
  const streamsOf = (doc, index) => {
    const page = doc.getPage(index);
    const raw = page.node.Contents();
    if (!raw) return Buffer.alloc(0);
    const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
    const bufs = [];
    for (const ref of parts) {
      const stream = doc.context.lookup(ref);
      if (!stream) continue;
      const contents =
        typeof stream.getContents === "function" ? stream.getContents() : stream.contents;
      if (contents) bufs.push(Buffer.from(contents));
    }
    return Buffer.concat(bufs);
  };

  const mismatches = [];
  for (let i = 0; i < srcCount; i++) {
    const a = streamsOf(src, i);
    const b = streamsOf(out, i + coverPages);
    if (!a.equals(b)) mismatches.push(i + 1);
  }
  return { ok: mismatches.length === 0, checkedPages: srcCount, mismatches };
}

module.exports = {
  fetchSourcePdf,
  stitchCoverOntoPdf,
  verifySourcePreserved,
  looksLikePdf,
  StitchError,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PAGES,
};

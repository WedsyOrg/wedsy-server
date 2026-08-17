/**
 * utils/venueRichText.js — validate and render the constrained block tree used
 * by the cancellation policy (S1c).
 *
 * ── WHY A BLOCK TREE AND NOT HTML ───────────────────────────────────────────
 * The editor is TipTap, whose document model is already structured JSON. We
 * store that structure rather than serialised HTML, and the reason is the PDF:
 * this policy has to render through pdfkit, and walking a typed tree of four
 * node kinds is a small, total function, whereas parsing arbitrary HTML on the
 * server means shipping a parser, a sanitiser, and a long tail of "what does
 * <div style> mean in a PDF" decisions. Storing HTML also means every read is a
 * trust decision; storing this means the shape is checked once, on write.
 *
 * The schema is deliberately tiny — heading (1..3), paragraph, bulletList,
 * orderedList, and a bold inline mark. That is exactly what the brief asks for.
 * No merge fields, no import, no tables, images or links: those are the T&C
 * editor's problems, deferred for good reasons, and each is a fidelity risk on
 * a document that decides refunds.
 *
 * ── THE LENGTH GUARD IS NOT OPTIONAL ────────────────────────────────────────
 * pdfkit 0.17.2's native table SILENTLY TRUNCATES a cell taller than one page —
 * no error, and the following row still renders, so the document looks intact.
 * The cancellation policy can be attached to a booking confirmation whose
 * payment schedule IS a table, and a policy is exactly the kind of prose that
 * gets long. So total length is capped on write, where it can be reported to
 * the owner, rather than discovered as missing text on a customer's document.
 */

const MAX_BLOCKS = 200;
const MAX_ITEMS_PER_LIST = 100;
const MAX_SPANS_PER_BLOCK = 100;
const MAX_SPAN_CHARS = 2000;
/**
 * ~24k characters is comfortably several pages of prose in the renderer below,
 * while staying far under anything that could threaten a single pdfkit cell if
 * a future document ever places the policy inside one.
 */
const MAX_TOTAL_CHARS = 24000;

const BLOCK_TYPES = new Set(["heading", "paragraph", "bulletList", "orderedList"]);

class RichTextError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_rich_text";
  }
}

const asText = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

function normalizeSpans(raw, where) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_SPANS_PER_BLOCK) throw new RichTextError(`${where} has too many text runs (max ${MAX_SPANS_PER_BLOCK})`);
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const text = asText(s.text);
    if (text.length > MAX_SPAN_CHARS) throw new RichTextError(`${where} has a text run over ${MAX_SPAN_CHARS} characters`);
    if (!text) continue; // an empty run carries no meaning and no formatting
    out.push({ text, bold: Boolean(s.bold) });
  }
  return out;
}

/**
 * Validate and normalise incoming blocks.
 *
 * Rejects rather than sanitises: an unknown node type is a client bug or an
 * attempt, and silently dropping it would store a policy that renders
 * differently from what the owner saw in the editor.
 *
 * @returns {{ blocks: Array, totalChars: number }}
 */
function normalizeBlocks(raw) {
  if (raw === null || raw === undefined) return { blocks: [], totalChars: 0 };
  if (!Array.isArray(raw)) throw new RichTextError("blocks must be an array");
  if (raw.length > MAX_BLOCKS) throw new RichTextError(`Too many blocks (max ${MAX_BLOCKS})`);

  const blocks = [];
  let totalChars = 0;
  raw.forEach((b, i) => {
    const where = `blocks[${i}]`;
    if (!b || typeof b !== "object") throw new RichTextError(`${where} is not an object`);
    const type = asText(b.type);
    if (!BLOCK_TYPES.has(type)) {
      throw new RichTextError(`${where} has unsupported type "${type}" — allowed: ${[...BLOCK_TYPES].join(", ")}`);
    }

    if (type === "bulletList" || type === "orderedList") {
      const itemsRaw = Array.isArray(b.items) ? b.items : [];
      if (itemsRaw.length > MAX_ITEMS_PER_LIST) throw new RichTextError(`${where} has too many items (max ${MAX_ITEMS_PER_LIST})`);
      const items = [];
      itemsRaw.forEach((it, j) => {
        const spans = normalizeSpans(it && it.spans, `${where}.items[${j}]`);
        if (!spans.length) return; // an empty bullet is noise on a document
        spans.forEach((s) => { totalChars += s.text.length; });
        items.push({ spans });
      });
      if (!items.length) return; // a list with nothing in it is not a block
      blocks.push({ type, items });
      return;
    }

    const spans = normalizeSpans(b.spans, where);
    if (!spans.length) return; // an empty paragraph/heading is dropped, not stored
    spans.forEach((s) => { totalChars += s.text.length; });
    const block = { type, spans };
    if (type === "heading") {
      const lvl = Number(b.level);
      // Anything outside 1..3 becomes 2 rather than failing the save: a heading
      // level is presentation, and losing the owner's whole policy over one is
      // the wrong trade. Unknown TYPES still fail, because those change meaning.
      block.level = Number.isFinite(lvl) && lvl >= 1 && lvl <= 3 ? Math.floor(lvl) : 2;
    }
    blocks.push(block);
  });

  if (totalChars > MAX_TOTAL_CHARS) {
    throw new RichTextError(
      `That policy is ${totalChars.toLocaleString("en-IN")} characters; the limit is ${MAX_TOTAL_CHARS.toLocaleString("en-IN")}. ` +
        "Shorten it or attach the full text as a PDF instead."
    );
  }
  return { blocks, totalChars };
}

/** Plain text of the whole document — for previews, search and length checks. */
function blocksToPlainText(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === "bulletList" || b.type === "orderedList") {
      (b.items || []).forEach((it, i) => {
        const text = (it.spans || []).map((s) => s.text).join("");
        out.push(`${b.type === "orderedList" ? `${i + 1}.` : "•"} ${text}`);
      });
    } else {
      out.push((b.spans || []).map((s) => s.text).join(""));
    }
  }
  return out.join("\n");
}

/**
 * Render the block tree into an open pdfkit document.
 *
 * Bold is applied per RUN, which is why spans exist: pdfkit's `continued: true`
 * chain lets one visual line switch font mid-sentence, and that is the whole
 * reason the inline mark is modelled rather than bolding whole blocks.
 *
 * @param {PDFDocument} doc      already positioned; the caller owns the header
 * @param {Array} blocks
 * @param {object} [opts]
 * @param {number} [opts.width=495]  matches the venuePdf x-grid
 * @param {string} [opts.bodyColor="#222222"]
 * @param {string} [opts.headingColor="#6b1e2e"]
 */
function renderBlocksToPdf(doc, blocks, opts = {}) {
  const { width = 495, bodyColor = "#222222", headingColor = "#6b1e2e" } = opts;
  const HEADING_SIZE = { 1: 14, 2: 12, 3: 11 };

  const runs = (spans, size, color) => {
    const list = (spans || []).filter((s) => s.text);
    if (!list.length) return;
    list.forEach((s, i) => {
      doc
        .font(s.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(size)
        .fillColor(color)
        // `continued` on every run but the last keeps them on one flowing line.
        .text(s.text, { width, continued: i < list.length - 1 });
    });
  };

  for (const b of blocks || []) {
    if (b.type === "heading") {
      doc.moveDown(0.45);
      runs(b.spans, HEADING_SIZE[b.level || 2] || 12, headingColor);
      doc.moveDown(0.15);
      continue;
    }
    if (b.type === "paragraph") {
      runs(b.spans, 10, bodyColor);
      doc.moveDown(0.35);
      continue;
    }
    if (b.type === "bulletList" || b.type === "orderedList") {
      (b.items || []).forEach((it, i) => {
        const marker = b.type === "orderedList" ? `${i + 1}. ` : "•  ";
        // The marker is its own non-bold run so a bolded item does not bold it.
        doc.font("Helvetica").fontSize(10).fillColor(bodyColor).text(marker, { width, continued: true });
        const list = (it.spans || []).filter((s) => s.text);
        if (!list.length) {
          doc.text("");
        } else {
          list.forEach((s, j) => {
            doc
              .font(s.bold ? "Helvetica-Bold" : "Helvetica")
              .fontSize(10)
              .fillColor(bodyColor)
              .text(s.text, { width, continued: j < list.length - 1 });
          });
        }
        doc.moveDown(0.18);
      });
      doc.moveDown(0.25);
      doc.font("Helvetica");
    }
  }
  doc.font("Helvetica").fillColor(bodyColor);
}

module.exports = {
  normalizeBlocks,
  blocksToPlainText,
  renderBlocksToPdf,
  RichTextError,
  MAX_BLOCKS,
  MAX_TOTAL_CHARS,
  BLOCK_TYPES,
};

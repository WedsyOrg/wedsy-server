/**
 * utils/venueDocTable.js — pdfkit 0.17.2 native tables, with the two limits the
 * upgrade spike (#131) measured handled in one place.
 *
 * ── LIMIT 1: A CELL TALLER THAN ONE PAGE SILENTLY TRUNCATES ─────────────────
 * Measured: 347 tokens in a cell render complete, 348 truncate at 346 — no
 * error, no warning, and the row AFTER the oversized one still renders, so the
 * document looks intact. The loss is invisible unless you count.
 *
 * Payment tables are many short rows and never hit it. Anything holding prose
 * does, so `guardCell` caps and marks with an ellipsis: once we are rendering,
 * refusing to produce the document is worse than producing one that visibly
 * says there is more. The real defence is the length cap on write
 * (utils/venueRichText), where the owner can still act on it.
 *
 * ── LIMIT 2: THE HEADER IS NOT REPEATED ON CONTINUATION PAGES ───────────────
 * Also measured: a 120-row table paginates correctly (3 pages, every row
 * present, in order) but page 2+ carry no column labels, and there is no
 * built-in option — `headerRowLookup` in the source is accessibility structure
 * tagging, not visual repetition.
 *
 * The obvious fix does not work, and the first draft of this file shipped it:
 * watch for a page change after each `t.row()` and re-emit the header. By the
 * time a break is detectable the row has ALREADY been drawn on the new page, so
 * the header lands underneath it. (Worse, `bufferedPageRange()` only tracks
 * pages when the document was opened with `bufferPages: true`, so the check
 * silently never fired at all.)
 *
 * So this paginates deliberately instead: measure the height of the first
 * rendered row, then fill each page with as many rows as fit, END that table,
 * `addPage()`, and start a FRESH table with the header on top. One table per
 * page means the header is always the first thing on it, which is the only
 * arrangement that puts it where a reader expects.
 */

const DEFAULT_MAX_CELL_CHARS = 900;
/** Leave a little room so a row never sits flush against the bottom margin. */
const BOTTOM_SAFETY = 6;

/**
 * Cap one cell's text so pdfkit cannot silently drop the tail.
 * @returns {{ text: string, truncated: boolean }}
 */
function guardCell(value, maxChars = DEFAULT_MAX_CELL_CHARS) {
  const s = value === null || value === undefined ? "" : String(value);
  if (s.length <= maxChars) return { text: s, truncated: false };
  const hard = s.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > maxChars - 120 ? hard.slice(0, lastSpace) : hard;
  return { text: `${cut}…`, truncated: true };
}

/**
 * Render a table, repeating the header on every page it spans.
 *
 * @param {PDFDocument} doc
 * @param {object} args
 * @param {Array} args.header            header cells
 * @param {Array<Array>} args.rows       body rows
 * @param {object} [args.opts]           passed to doc.table (columnStyles etc.)
 * @param {number} [args.maxCellChars]
 * @returns {{ rows: number, pages: number, headerRepeats: number, truncatedCells: number }}
 */
function renderTable(doc, { header, rows, opts = {}, maxCellChars = DEFAULT_MAX_CELL_CHARS }) {
  let truncatedCells = 0;

  const guardRow = (row) =>
    (row || []).map((cell) => {
      // An object cell carries its own styling (colSpan, backgroundColor…); only
      // its text needs guarding.
      if (cell && typeof cell === "object" && !Array.isArray(cell)) {
        const g = guardCell(cell.text, maxCellChars);
        if (g.truncated) truncatedCells += 1;
        return { ...cell, text: g.text };
      }
      const g = guardCell(cell, maxCellChars);
      if (g.truncated) truncatedCells += 1;
      return g.text;
    });

  const safeHeader = guardRow(header);
  const body = (rows || []).map(guardRow);

  let pages = 1;
  let headerRepeats = 0;
  let i = 0;
  // Unknown until a row has actually been drawn; measured from the first one and
  // then re-measured as we go, so a taller row set self-calibrates rather than
  // relying on a guessed constant.
  let rowHeight = null;

  while (i < body.length || i === 0) {
    const t = doc.table(opts);
    t.row(safeHeader);
    if (pages > 1) headerRepeats += 1;

    let placedOnThisPage = 0;
    while (i < body.length) {
      const yBefore = doc.y;
      // Would the next row cross the bottom margin? Only ask once we know how
      // tall a row is, and never break before placing at least one row, or a
      // tall row would loop forever adding empty pages.
      if (rowHeight !== null && placedOnThisPage > 0 && yBefore + rowHeight + BOTTOM_SAFETY > doc.page.maxY()) {
        break;
      }
      t.row(body[i]);
      const grew = doc.y - yBefore;
      if (grew > 0) rowHeight = rowHeight === null ? grew : Math.max(rowHeight, grew);
      i += 1;
      placedOnThisPage += 1;
    }
    t.end();

    if (i >= body.length) break;
    doc.addPage();
    pages += 1;
  }

  return { rows: body.length, pages, headerRepeats, truncatedCells };
}

module.exports = { renderTable, guardCell, DEFAULT_MAX_CELL_CHARS, BOTTOM_SAFETY };

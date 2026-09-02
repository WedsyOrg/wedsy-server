/**
 * utils/docsystem/engine.js — the ONE renderer.
 *
 * Every document builder draws through this class. It knows pages, the
 * shared type roles, the table engine and the print rules; it asks the
 * LANGUAGE (a token set + seven recipes) for header, footer, title block,
 * frame, table heads, emphasis blocks and group treatments — and for nothing
 * else. If code outside languages/ ever branches on the language name, the
 * architecture has failed (LANGUAGES.md).
 *
 * Print rules held HERE, for every language (LANGUAGES.md §1):
 *   · a table row never splits across pages;
 *   · every column head repeats on each page a table touches;
 *   · header and footer are drawn on every page from one function;
 *   · a section label keeps at least its first two rows;
 *   · body content starts below the reserved header and stops
 *     SPACE.footerClearance above the footer rule.
 */
const PDFDocument = require("pdfkit");
const { A4, MM, TYPE, SPACE, DASH, PAGE_SCALE } = require("./shared");

const trk = (size, em) => size * em; // pdfkit characterSpacing is points, not em

class Engine {
  /**
   * @param {object} o
   * @param {object} o.language  one of languages/*
   * @param {object} o.identity  { name, monogram, tagline, legalName, addressLines[], pan, gstin, phone, email, stateLine? , logoBuffer? }
   * @param {object} o.meta      { reference } — the footer's document reference
   * @param {boolean} [o.compress=true]  test harnesses pass false to read bytes
   */
  constructor({ language, identity, meta, compress = true }) {
    this.L = language;
    this.T = language.tokens;
    this.identity = identity;
    this.meta = meta;
    this.doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, compress });
    this.chunks = [];
    this.doc.on("data", (c) => this.chunks.push(c));
    this._designPage(); // the first page's stream is already open
    this.pageIndex = -1;
    this.margin = this.T.pageMargin * MM + (this.T.contentInset || 0);
    this.width = A4.w - this.margin * 2;
    this.newPage();
  }

  // ── pages ────────────────────────────────────────────────────────────────
  /**
   * Put the open page into DESIGN UNITS: scale the content stream by 0.75 so
   * CSS px from the handoff draw 1:1, and stretch pdfkit's idea of the page
   * height to the design height — its y-flip and its auto-pagination both
   * read page.height, and left at 842 they would flip against the wrong
   * origin and split pages on their own. The MediaBox stays A4 (written from
   * the size at page creation), which the suite asserts.
   */
  _designPage() {
    this.doc.scale(PAGE_SCALE);
    this.doc.page.height = A4.h;
    this.doc.page.width = A4.w;
  }

  newPage() {
    if (this.pageIndex >= 0) {
      this.doc.addPage({ size: "A4", margin: 0 });
      this._designPage();
    }
    this.pageIndex += 1;
    this.L.frame(this);
    const headerBottom = this.L.header(this);
    this.footerTop = this.L.footer(this);
    this.contentTop = headerBottom + SPACE.block;
    this.contentBottom = this.footerTop - SPACE.footerClearance;
    this.y = this.contentTop;
  }

  /** Room left on this page. */
  room() { return this.contentBottom - this.y; }

  /** Guarantee `h` of vertical room; breaks the page when it is not there. */
  ensure(h) {
    if (this.y + h > this.contentBottom) this.newPage();
  }

  finish() {
    return new Promise((resolve) => {
      this.doc.on("end", () => resolve(Buffer.concat(this.chunks)));
      this.doc.end();
    });
  }

  // ── primitives ──────────────────────────────────────────────────────────
  rule(x1, y, x2, weight = 0.5, color = this.T.ink, dash = null) {
    const d = this.doc;
    d.save();
    if (dash) d.dash(dash, { space: dash });
    d.moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke();
    d.restore();
  }
  vrule(x, y1, y2, weight = 0.75, color = this.T.hairline) {
    this.doc.save().moveTo(x, y1).lineTo(x, y2).lineWidth(weight).strokeColor(color).stroke().restore();
  }
  box(x, y, w, h, { weight = 1.5, color = this.T.ink, fill = null, dash = null } = {}) {
    const d = this.doc;
    d.save();
    if (fill) d.rect(x, y, w, h).fill(fill);
    if (weight) {
      if (dash) d.dash(dash, { space: dash });
      d.rect(x, y, w, h).lineWidth(weight).strokeColor(color).stroke();
    }
    d.restore();
  }

  /**
   * One text run. Options: font, size, color, tracking (em), align, width,
   * x, y (defaults to cursor), lineGap. Returns the height consumed.
   * When `advance` is false the cursor does not move (for side-by-side cells).
   */
  text(str, opts = {}) {
    const d = this.doc;
    const font = opts.font || "Helvetica";
    const size = opts.size || TYPE.body;
    const x = opts.x !== undefined ? opts.x : this.margin;
    const y = opts.y !== undefined ? opts.y : this.y;
    const width = opts.width !== undefined ? opts.width : this.margin + this.width - x;
    d.font(font).fontSize(size).fillColor(opts.color || this.T.ink);
    const characterSpacing = opts.tracking ? trk(size, opts.tracking) : 0;
    const textOpts = { width, align: opts.align || "left", characterSpacing, lineGap: opts.lineGap || 0 };
    const s = opts.caps ? String(str).toUpperCase() : String(str);
    const h = d.heightOfString(s, textOpts);
    d.text(s, x, y, textOpts);
    if (opts.advance !== false && opts.y === undefined) this.y = y + h;
    return h;
  }

  measure(str, { font = "Helvetica", size = TYPE.body, width, tracking = 0, lineGap = 0 } = {}) {
    const d = this.doc;
    d.font(font).fontSize(size);
    return d.heightOfString(String(str), { width, characterSpacing: trk(size, tracking), lineGap });
  }

  gap(h) { this.y += h; }

  // ── section label: Times-Italic 14, keeps its first two rows ─────────────
  sectionLabel(label, { keep = 60, color = this.T.ink } = {}) {
    this.ensure(SPACE.section + 18 + keep);
    this.gap(SPACE.section);
    this.text(label, { font: "Times-Italic", size: TYPE.sectionLabel, color, tracking: 0.01 });
    this.gap(8);
  }

  // ── the table engine ─────────────────────────────────────────────────────
  /**
   * @param {object} t
   * @param {Array}  t.columns [{key, label, width (fraction), align, numeric}]
   * @param {Array}  t.rows    [{cells:{key: string|{text, subLine?, bold?, color?, indent?}}, kind?: 'data'|'subtotal'|'total'|'sub'}]
   * @param {number} [t.cellSize]
   * @param {number} [t.x] [t.width]
   */
  table({ columns, rows, cellSize = TYPE.cell, x = this.margin, width = this.width, headRepeat = true }) {
    const colX = [];
    let acc = x;
    for (const c of columns) { colX.push(acc); acc += c.width * width; }
    // every column but the last keeps an 8px right gutter, so two adjacent
    // right-aligned columns (collectable | state) can never touch
    const colW = columns.map((c, i) => c.width * width - (i === columns.length - 1 ? 0 : 8));

    const drawHead = () => {
      this.ensure(26);
      this.y = this.L.tableHead(this, { columns, colX, colW, x, width, y: this.y });
    };
    drawHead();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const pad = row.kind === "sub" ? 4 : SPACE.cellPad;
      // measure the row before drawing — the height must be known first
      let rowH = 0;
      for (let c = 0; c < columns.length; c++) {
        const cell = row.cells[columns[c].key];
        if (cell === undefined || cell === null) continue;
        const v = typeof cell === "object" ? cell : { text: cell };
        const size = v.size || (row.kind === "sub" ? 10.5 : cellSize);
        const indent = v.indent || 0;
        let h = this.measure(v.text, { font: v.bold ? "Helvetica-Bold" : "Helvetica", size, width: colW[c] - indent - (columns[c].numeric ? 0 : 8) });
        if (v.subLine) h += 2 + this.measure(v.subLine, { size: TYPE.subLine, width: colW[c] - indent - 8 });
        rowH = Math.max(rowH, h);
      }
      rowH += pad * 2;
      if (this.y + rowH > this.contentBottom) {
        this.newPage();
        if (headRepeat) drawHead();
      }
      const top = this.y;
      // row chrome by kind
      if (row.fill) this.doc.save().rect(x, top, width, rowH).fill(row.fill), this.doc.restore();
      for (let c = 0; c < columns.length; c++) {
        const cell = row.cells[columns[c].key];
        if (cell === undefined || cell === null) continue;
        const v = typeof cell === "object" ? cell : { text: cell };
        const size = v.size || (row.kind === "sub" ? 10.5 : cellSize);
        const indent = v.indent || 0;
        const alignRight = columns[c].numeric || columns[c].align === "right";
        const color = v.color || (row.kind === "sub" ? this.T.mid : v.text === DASH ? this.T.mid : this.T.ink);
        this.text(v.text, {
          font: v.bold ? "Helvetica-Bold" : "Helvetica", size, color,
          x: colX[c] + indent, y: top + pad,
          width: colW[c] - indent - (alignRight ? 0 : 8),
          align: alignRight ? "right" : "left", advance: false,
        });
        if (v.subLine) {
          const mainH = this.measure(v.text, { font: v.bold ? "Helvetica-Bold" : "Helvetica", size, width: colW[c] - indent - 8 });
          this.text(v.subLine, {
            size: TYPE.subLine, color: this.T.mid,
            x: colX[c] + indent, y: top + pad + mainH + 2,
            width: colW[c] - indent - 8, advance: false,
          });
        }
      }
      this.y = top + rowH;
      // separators: hairline between data rows; 1px ink closes the data set
      const next = rows[i + 1];
      if (row.kind === "total") this.rule(x, this.y, x + width, this.T.ruleWeights.tableTotal || 1, this.T.ink);
      else if (row.lastData) this.rule(x, this.y, x + width, 1, this.T.ink);
      else if (next && row.kind !== "subtotal") this.rule(x, this.y, x + width, this.T.ruleWeights.rowSep || 0.75, this.T.hairline);
    }
  }

  // ── the two semantic groups, via the language's treatment ────────────────
  refundableBand(drawContent, estHeight) {
    this.ensure(estHeight + 24);
    this.L.groupTreatment(this, "refundable", drawContent, estHeight);
  }
  extrasGroup(drawContent, estHeight) {
    this.ensure(estHeight + 24);
    this.L.groupTreatment(this, "extras", drawContent, estHeight);
  }

  emphasisBlock(drawContent, { x = this.margin, width = this.width, estHeight = 120 } = {}) {
    this.ensure(estHeight + 12);
    return this.L.emphasisBlock(this, drawContent, { x, width });
  }

  /**
   * Measure-then-decorate: run `drawContent` invisibly to learn its height,
   * paint the decoration (fills, edges) at the EXACT height, then draw the
   * content for real. Used by fill-bearing recipes so a fill can never fall
   * short of its content. The content must fit the current page — callers
   * ensure() an estimate first.
   */
  measuredBlock(drawContent, decorate) {
    const startY = this.y;
    this.doc.save().fillOpacity(0).strokeOpacity(0);
    drawContent(true);
    this.doc.restore();
    const h = this.y - startY;
    this.y = startY;
    decorate(startY, h);
    drawContent(false);
    this.y = startY + h;
    return h;
  }
}

module.exports = { Engine, trk };

/**
 * utils/docsystem/languages.js — four token sets and seven recipes.
 *
 * REVISED (Sep 2026 handoff revision). The governing change, quoted:
 * "Nothing is enclosed. No panel borders, no card fills, no bordered tags,
 * no monogram box, no framed sheet. Emphasis is a heavier horizontal rule, a
 * larger Times figure, or white space — never an outline. The only fills in
 * the system are Panel's two full-bleed bands and its reversed table-head
 * row, each spanning the full measure edge to edge, so nothing floats."
 *
 * What that removed here: the tint token, every measured fill, the monogram
 * box, Stationery's double accent frame (frame() is identity in all four;
 * Stationery regains the full 14mm measure), every emphasis box (now a
 * single top rule whose WEIGHT is the emphasis), the refundable tag (now a
 * "Refundable —" accent lead-in between dashed rules) and the extras fill
 * (now accent rules above and below).
 *
 * A language is ONE object: its owned values (§2.1) and the seven recipes
 * (§2.2). The engine and the five documents never read a colour or an owned
 * size directly and never branch on a language name.
 *
 * The §3 adaptations remain stated rules: Ledger's rail is full-height when
 * the body is one column, masthead-height when it is not; Stationery's
 * statement states the outstanding at display size ONCE
 * (heroSizes.statementClosing = null); Panel's dark is two full-bleed bands
 * and the reversed table heads — the reversed amount blocks are gone
 * (~6% ink, was ~9%).
 */
const { A4, MM, TYPE, SPACE, WORDING } = require("./shared");

// ── shared header fragments ─────────────────────────────────────────────────
function rulePair(R, x1, x2, y) {
  R.rule(x1, y, x2, 1.5, R.T.ink);
  R.rule(x1, y + 3, x2, 0.5, R.T.ink);
  return y + 3.5;
}

function registrationLines(identity) {
  const right = [identity.pan ? `PAN ${identity.pan}` : null, identity.gstin ? `GSTIN ${identity.gstin}` : null,
    identity.stateLine || [identity.phone, identity.email].filter(Boolean).join(" · ")].filter(Boolean);
  const left = [identity.legalName, ...(identity.addressLines || [])].filter(Boolean);
  return { left, right };
}

function footerLine(identity, meta) {
  return [identity.name, identity.legalName, identity.email, identity.phone].filter(Boolean).join(" · ")
    + (meta.reference ? ` · ${meta.reference}` : "");
}

/**
 * The centred mark. NO monogram box anywhere: a real logo sits ABOVE the
 * name at 46px and the name drops one size; without a logo the name alone
 * carries the mark, one size larger. Returns the y below the mark.
 */
function centredMark(R, top, { noLogo, withLogo, tracking }) {
  const { identity, margin } = R;
  let y = top;
  if (identity.logoBuffer) {
    try {
      R.doc.image(identity.logoBuffer, A4.w / 2 - 60, y, { fit: [120, 46], align: "center", valign: "center" });
      y += 46 + 8;
    } catch (_) { /* a bad image falls back to the name alone */ }
  }
  const size = identity.logoBuffer ? withLogo : noLogo;
  R.text(identity.name, { font: "Times-Roman", size, caps: true, tracking, x: margin, y, width: R.width, align: "center", advance: false });
  return y + size * 1.05;
}

// ═══ CLASSIC ═════════════════════════════════════════════════════════════════
const classic = {
  name: "classic",
  tokens: {
    ink: "#191713", mid: "#6F6A61", hairline: "#DED9CF", accent: "#8A4F32", tint: null,
    pageMargin: 14, contentInset: 0,
    ruleWeights: { emphasis: 3, masthead: 1.5, tableTotal: 1, rowSep: 0.75, footer: 0.5, emphasisTop: 0.75 },
    fillPolicy: "rules",
    titleSize: 32, heroSizes: { statement: 38, receipt: 44, statementClosing: 30 }, totalFigureSize: 28,
    columnHead: { size: 8.5, tracking: 0.12 },
    nameSizes: { noLogo: 26, withLogo: 23, tracking: 0.24 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = 14 * MM;
    const { left, right } = registrationLines(identity);
    let markBottom = centredMark(R, top, classic.tokens.nameSizes);
    if (identity.tagline) {
      R.text(identity.tagline, { size: 8, caps: true, tracking: 0.30, color: R.T.mid, x: margin, y: markBottom + 5, width: R.width, align: "center", advance: false });
      markBottom += 5 + 9;
    }
    R.text(left.join("\n"), { size: 9.5, color: R.T.mid, tracking: 0.03, lineGap: 3.5, x: margin, y: top + 2, width: R.width * 0.3, advance: false });
    R.text(right.join("\n"), { size: 9.5, color: R.T.mid, lineGap: 3.5, x: margin + R.width * 0.7, y: top + 2, width: R.width * 0.3, align: "right", advance: false });
    return rulePair(R, margin, margin + R.width, markBottom + 12);
  },
  footer(R) {
    const y = A4.h - 14 * MM - 22;
    R.rule(R.margin, y, R.margin + R.width, 0.5, R.T.ink);
    R.text(footerLine(R.identity, R.meta), { size: 9.5, color: R.T.mid, x: R.margin, y: y + 9, width: R.width * 0.72, advance: false });
    R.text(WORDING.poweredBy, { size: 8, caps: true, tracking: 0.22, color: R.T.mid, x: R.margin + R.width * 0.6, y: y + 10, width: R.width * 0.4, align: "right", advance: false });
    return y;
  },
  titleBlock(R, m) {
    R.gap(8);
    // a DENSE document (the statement) left-aligns its title — the one
    // centred-title language honours the shared anatomy rule
    const align = m.dense ? "left" : "center";
    R.text(m.eyebrow, { size: 8.5, caps: true, tracking: 0.28, color: R.T.accent, align });
    R.gap(9);
    R.text(m.title, { font: "Times-Roman", size: R.T.titleSize, align, lineGap: 2 });
    if (m.subject) { R.gap(8); R.text(m.subject, { size: TYPE.body, color: R.T.mid, align }); }
    if (m.refs && m.refs.length) {
      R.gap(12);
      const w = m.dense ? R.width : R.width * 0.66;
      const x = m.dense ? R.margin : R.margin + (R.width - w) / 2;
      R.rule(x, R.y, x + w, 0.5, R.T.hairline);
      R.gap(9);
      R.text(m.refs.join("      "), { size: TYPE.reference, tracking: 0.04, color: R.T.mid, x, width: w, align });
    }
  },
  frame() { /* identity — in all four languages */ },
  tableHead(R, { columns, colX, colW, x, width, y }) {
    const c = R.T.columnHead;
    columns.forEach((col, i) => {
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.mid, x: colX[i], y, width: colW[i] - (col.numeric ? 0 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    const yy = y + c.size + 6;
    R.rule(x, yy, x + width, 1, R.T.ink);
    return yy + 1;
  },
  // NO BOX in any language: the block is set apart by ONE top rule's weight
  // and the Times figure, never an enclosure.
  emphasisBlock(R, draw, { x, width }) {
    R.rule(x, R.y, x + width, R.T.ruleWeights.emphasisTop, R.T.ink);
    R.gap(SPACE.panelPad);
    draw(x, width);
    R.gap(4);
  },
  groupTreatment(R, kind, draw) {
    if (kind === "refundable") {
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(9);
      draw({});
      R.gap(9);
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(1);
    } else {
      // extras: solid accent rules above and below — no fill, no left edge
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent);
      R.gap(SPACE.panelPad);
      draw({ inset: 0 });
      R.gap(SPACE.panelPad);
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent);
      R.gap(1);
    }
  },
};

// ═══ LEDGER ══════════════════════════════════════════════════════════════════
const ledger = {
  name: "ledger",
  tokens: {
    ...classic.tokens,
    ruleWeights: { emphasis: 3, masthead: 1.5, tableTotal: 0.5, rowSep: 0.75, footer: 0.5, emphasisTop: 3 },
    titleSize: 40, heroSizes: { statement: 42, receipt: 44, statementClosing: 30 }, totalFigureSize: 28,
    columnHead: { size: 8, tracking: 0.18 },
    nameSizes: { noLogo: 22, withLogo: 19, tracking: 0.13 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = 14 * MM;
    const { left, right } = registrationLines(identity);
    // the name stacked two lines at far left — no box, the name is the mark
    let y = top;
    if (identity.logoBuffer) {
      try { R.doc.image(identity.logoBuffer, margin, y, { fit: [100, 40] }); y += 44; } catch (_) { /* name alone */ }
    }
    const size = identity.logoBuffer ? ledger.tokens.nameSizes.withLogo : ledger.tokens.nameSizes.noLogo;
    const words = identity.name.split(" ");
    const l1 = words.slice(0, Math.ceil(words.length / 2)).join(" ");
    const l2 = words.slice(Math.ceil(words.length / 2)).join(" ");
    R.text(l1, { font: "Times-Roman", size, caps: true, tracking: ledger.tokens.nameSizes.tracking, x: margin, y, width: R.width * 0.34, advance: false });
    R.text(l2 || " ", { font: "Times-Roman", size, caps: true, tracking: ledger.tokens.nameSizes.tracking, x: margin, y: y + size + 3, width: R.width * 0.34, advance: false });
    const nameBottom = y + size * 2 + 6;
    const railX = R.margin + R.width * 0.36;
    R.vrule(railX, top, top + 44, 0.75, R.T.hairline);
    R.text(left.join(" · "), { size: 9.5, color: R.T.mid, lineGap: 3, x: railX + 14, y: top + 2, width: R.width * 0.34, advance: false });
    R.text(right.join("\n"), { size: 9.5, color: R.T.mid, lineGap: 3.5, x: R.margin + R.width * 0.74, y: top + 2, width: R.width * 0.26, align: "right", advance: false });
    return rulePair(R, margin, margin + R.width, Math.max(nameBottom, top + 46) + 10);
  },
  footer: classic.footer,
  titleBlock(R, m) {
    R.gap(8);
    const railW = R.width * 0.30;
    const bodyW = R.width - railW - 24;
    const y0 = R.y;
    R.text(m.eyebrow, { size: 8.5, caps: true, tracking: 0.28, color: R.T.accent, width: bodyW });
    R.gap(9);
    R.text(m.title, { font: "Times-Roman", size: R.T.titleSize, width: bodyW, lineGap: 2 });
    if (m.subject) { R.gap(6); R.text(m.subject, { size: TYPE.body, color: R.T.mid, width: bodyW }); }
    const leftBottom = R.y;
    if (m.refs && m.refs.length) {
      const rx = R.margin + R.width - railW;
      R.vrule(rx - 12, y0 + 2, y0 + 2 + m.refs.length * 16, 0.75, R.T.hairline);
      m.refs.forEach((ref, i) => {
        R.text(ref, { size: TYPE.reference, tracking: 0.04, color: R.T.mid, x: rx, y: y0 + 4 + i * 16, width: railW, advance: false });
      });
      R.y = Math.max(leftBottom, y0 + 4 + m.refs.length * 16);
    }
  },
  frame() { /* identity */ },
  tableHead(R, { columns, colX, colW, x, width, y }) {
    const c = R.T.columnHead;
    columns.forEach((col, i) => {
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.mid, x: colX[i], y, width: colW[i] - (col.numeric ? 0 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    const yy = y + c.size + 6;
    R.rule(x, yy, x + width, 0.5, R.T.ink);
    return yy + 1;
  },
  emphasisBlock(R, draw, { x, width }) {
    R.rule(x, R.y, x + width, R.T.ruleWeights.emphasisTop, R.T.ink);
    R.gap(SPACE.panelPad);
    draw(x, width);
    R.gap(4);
  },
  groupTreatment: classic.groupTreatment,
};

// ═══ STATIONERY ══════════════════════════════════════════════════════════════
const stationery = {
  name: "stationery",
  tokens: {
    ...classic.tokens,
    pageMargin: 14, contentInset: 0,
    ruleWeights: { emphasis: 0.75, masthead: 0.5, tableTotal: 0.75, rowSep: 0.5, footer: 0.5, emphasisTop: 0.75 },
    titleSize: 34, heroSizes: { statement: 34, receipt: 54, statementClosing: null }, totalFigureSize: 32, totalFigureSizeDense: 30,
    columnHead: { size: 8.5, tracking: 0.16 },
    nameSizes: { noLogo: 26, withLogo: 23, tracking: 0.24 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = 14 * MM;
    let y = centredMark(R, top, stationery.tokens.nameSizes);
    if (identity.tagline) {
      R.text(identity.tagline, { size: 8, caps: true, tracking: 0.30, color: R.T.mid, x: margin, y: y + 5, width: R.width, align: "center", advance: false });
      y += 5 + 9;
    }
    const reg = [identity.legalName, ...(identity.addressLines || []), identity.pan ? `PAN ${identity.pan}` : null, identity.gstin ? `GSTIN ${identity.gstin}` : null].filter(Boolean).join(" · ");
    R.text(reg, { size: 8, caps: true, tracking: 0.18, color: R.T.mid, x: margin, y: y + 6, width: R.width, align: "center", advance: false });
    const bottom = y + 6 + 12 + 8;
    // closed by a 0.5px ink rule — the frame is gone; this rule holds the line
    R.rule(margin, bottom, margin + R.width, 0.5, R.T.ink);
    return bottom + 1;
  },
  footer(R) {
    const y = A4.h - 14 * MM - 20;
    R.rule(R.margin, y, R.margin + R.width, 0.5, R.T.hairline);
    R.text(`${footerLine(R.identity, R.meta)}   ·   ${WORDING.poweredBy.toUpperCase()}`, { size: 8.5, color: R.T.mid, x: R.margin, y: y + 6, width: R.width, align: "center", advance: false });
    return y;
  },
  titleBlock(R, m) {
    R.gap(6);
    // the eyebrow between two accent rules
    const w = R.width * 0.5; const x = R.margin + (R.width - w) / 2;
    const midY = R.y + 5;
    R.rule(x, midY, x + w * 0.32, 0.75, R.T.accent);
    R.rule(x + w * 0.68, midY, x + w, 0.75, R.T.accent);
    R.text(m.eyebrow, { size: 8.5, caps: true, tracking: 0.28, color: R.T.accent, x, y: R.y, width: w, align: "center" });
    R.gap(12);
    if (m.presentedTo) {
      R.text("presented to", { font: "Times-Italic", size: 13, color: R.T.mid, align: "center" });
      R.gap(4);
      R.text(m.presentedTo, { font: "Times-Roman", size: 21, align: "center" });
      R.gap(8);
    }
    R.text(m.title, { font: "Times-Roman", size: R.T.titleSize, align: "center", lineGap: 2 });
    {
      // "presented to" already names the client — never say it twice
      const subject = m.presentedTo && m.subject && m.subject.includes(m.presentedTo) ? null : m.subject;
      if (subject) { R.gap(6); R.text(subject, { font: "Times-Italic", size: 13, color: R.T.mid, align: "center" }); }
    }
    if (m.refs && m.refs.length) {
      R.gap(10);
      R.text(m.refs.join("   ·   "), { size: TYPE.reference, tracking: 0.04, color: R.T.mid, align: "center" });
    }
  },
  frame() { /* identity — the double accent border was removed with the boxes */ },
  tableHead(R, { columns, colX, colW, x, width, y }) {
    const c = R.T.columnHead;
    columns.forEach((col, i) => {
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.mid, x: colX[i], y, width: colW[i] - (col.numeric ? 0 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    const yy = y + c.size + 6;
    R.rule(x, yy, x + width, 0.75, R.T.accent);
    return yy + 1;
  },
  emphasisBlock(R, draw, { x, width }) {
    R.rule(x, R.y, x + width, R.T.ruleWeights.emphasisTop, R.T.accent);
    R.gap(SPACE.panelPad);
    draw(x, width);
    R.gap(4);
  },
  groupTreatment: classic.groupTreatment,
};

// ═══ PANEL ═══════════════════════════════════════════════════════════════════
const panel = {
  name: "panel",
  tokens: {
    ink: "#17150F", mid: "#6B6455", hairline: "#C9BFA8", accent: "#8A6A2F", tint: null,
    reverseInk: "#17150F", reverseText: "#F4EFE2", gold: "#A08040", goldOnDark: "#D8B264", dim: "#9C937F", darkRule: "#4A4437",
    // the footer band's fill — one of the two full-bleed bands that, with the
    // reversed table-head rows, are the only fills left in the system
    bandFill: "#F1ECE0",
    pageMargin: 0, contentInset: 16 * MM,
    ruleWeights: { emphasis: 3, masthead: 1, tableTotal: 0.75, rowSep: 0.5, footer: 0.5, emphasisTop: 3 },
    fillPolicy: "bands",
    titleSize: 32, heroSizes: { statement: 38, receipt: 44, statementClosing: 30 }, totalFigureSize: 28,
    columnHead: { size: 8, tracking: 0.18 },
    nameSizes: { noLogo: 24, withLogo: 21, tracking: 0.18 },
  },
  header(R) {
    const { identity } = R;
    const padX = 16 * MM;
    const bandH = 84;
    R.doc.save().rect(0, 0, A4.w, bandH).fill(R.T.reverseInk).restore();
    if (identity.logoBuffer) {
      try { R.doc.image(identity.logoBuffer, padX, 20, { fit: [100, 44] }); } catch (_) { /* text fallback below */ }
      R.text(identity.name, { font: "Times-Roman", size: panel.tokens.nameSizes.withLogo, caps: true, tracking: panel.tokens.nameSizes.tracking, color: R.T.reverseText, x: padX + 112, y: 30, width: R.width * 0.5, advance: false });
    } else {
      R.text(identity.name, { font: "Times-Roman", size: panel.tokens.nameSizes.noLogo, caps: true, tracking: panel.tokens.nameSizes.tracking, color: R.T.reverseText, x: padX, y: 24, width: R.width * 0.6, advance: false });
      if (identity.tagline) R.text(identity.tagline, { size: 8, caps: true, tracking: 0.30, color: R.T.gold, x: padX, y: 52, width: R.width * 0.6, advance: false });
    }
    const { left, right } = registrationLines(identity);
    R.text([...left, ...right].join("  ·  "), { size: 9, color: R.T.dim, lineGap: 2.5, x: A4.w - padX - R.width * 0.42, y: 24, width: R.width * 0.42, align: "right", advance: false });
    return bandH;
  },
  footer(R) {
    const bandH = 34;
    const y = A4.h - bandH;
    R.doc.save().rect(0, y, A4.w, bandH).fill(panel.tokens.bandFill).restore();
    R.text(footerLine(R.identity, R.meta), { size: 9.5, color: R.T.mid, x: 16 * MM, y: y + 11, width: R.width * 0.72, advance: false });
    R.text(WORDING.poweredBy, { size: 8, caps: true, tracking: 0.22, color: R.T.mid, x: A4.w - 16 * MM - R.width * 0.4, y: y + 12, width: R.width * 0.4, align: "right", advance: false });
    return y;
  },
  titleBlock(R, m) {
    R.gap(6);
    const y0 = R.y;
    R.text(m.eyebrow, { size: 8.5, caps: true, tracking: 0.28, color: R.T.accent, width: R.width * 0.6 });
    R.gap(9);
    R.text(m.title, { font: "Times-Roman", size: R.T.titleSize, width: R.width * 0.62, lineGap: 2 });
    if (m.subject) { R.gap(6); R.text(m.subject, { size: TYPE.body, color: R.T.mid, width: R.width * 0.62 }); }
    if (m.refs && m.refs.length) {
      m.refs.forEach((ref, i) => {
        R.text(ref, { size: TYPE.reference, tracking: 0.04, color: R.T.mid, x: R.margin + R.width * 0.64, y: y0 + 4 + i * 16, width: R.width * 0.36, align: "right", advance: false });
      });
      R.y = Math.max(R.y, y0 + 4 + m.refs.length * 16);
    }
    R.gap(10);
    R.rule(R.margin, R.y, R.margin + R.width, 3, R.T.ink);
    R.gap(2);
  },
  frame() { /* the bands are the frame */ },
  tableHead(R, { columns, colX, colW, x, width, y }) {
    // the one fill left inside the measure: a full-measure reversed band
    const c = R.T.columnHead;
    const h = c.size + 12;
    R.doc.save().rect(x, y, width, h).fill(R.T.reverseInk).restore();
    columns.forEach((col, i) => {
      const inset = i === 0 ? 12 : 0;
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.goldOnDark, x: colX[i] + inset, y: y + 6, width: colW[i] - inset - (col.numeric ? 12 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    return y + h + 2;
  },
  // the reversed amount blocks are GONE: a 3px ink rule and the Times figure
  emphasisBlock(R, draw, { x, width }) {
    R.rule(x, R.y, x + width, R.T.ruleWeights.emphasisTop, R.T.ink);
    R.gap(SPACE.panelPad);
    draw(x, width);
    R.gap(4);
  },
  groupTreatment: classic.groupTreatment,
};

const LANGUAGES = { classic, ledger, stationery, panel };
const LANGUAGE_NAMES = Object.keys(LANGUAGES);

module.exports = { LANGUAGES, LANGUAGE_NAMES };

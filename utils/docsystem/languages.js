/**
 * utils/docsystem/languages.js — four token sets and seven recipes.
 *
 * A language is ONE object: its twelve owned values (LANGUAGES.md §2.1) and
 * the seven recipes (§2.2). The engine and the five document builders never
 * read a colour, size or margin directly and never branch on a language name
 * — everything a language may vary is expressed here, and nothing else is.
 *
 * The §3 adaptations are implemented as stated rules, not exceptions:
 *   · Ledger's rail is full-height when the body is one column (invoice,
 *     receipt — via `railMode` passed by the document's declared bodyKind),
 *     masthead-height when it is not;
 *   · Stationery × statement keeps the frame and centred masthead but
 *     left-aligns section labels and drops the hero to 32 (heroSizes);
 *   · Panel's dark is confined to masthead, table heads and the single
 *     reversed cell; its totals block is the tint slab with a 3px ink edge.
 */
const { A4, MM, TYPE, SPACE, WORDING } = require("./shared");
const { trk } = require("./engine");

// ── shared header fragments (drawn identically wherever a recipe wants them) ─
function crestMark(R, cx, topY, size = 46) {
  const { identity } = R;
  if (identity.logoBuffer) {
    try {
      R.doc.image(identity.logoBuffer, cx - size / 2, topY, { fit: [size * 2.2, size], align: "center", valign: "center" });
      return size;
    } catch (_) { /* fall through to the drawn monogram */ }
  }
  R.box(cx - size / 2, topY, size, size, { weight: 0.75, color: R.T.accent });
  R.doc.font("Times-Roman").fontSize(19).fillColor(R.T.accent);
  R.doc.text(identity.monogram, cx - size / 2, topY + size / 2 - 9, { width: size, align: "center", characterSpacing: trk(19, 0.08) });
  return size;
}

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

// ═══ CLASSIC ═════════════════════════════════════════════════════════════════
const classic = {
  name: "classic",
  tokens: {
    ink: "#191713", mid: "#6F6A61", hairline: "#DED9CF", accent: "#8A4F32", tint: "#F4F1EA",
    pageMargin: 14, contentInset: 0,
    ruleWeights: { emphasis: 3, masthead: 1.5, tableTotal: 1, rowSep: 0.75, footer: 0.5 },
    fillPolicy: "fills",
    titleSize: 32, heroSizes: { statement: 38, receipt: 44 }, totalFigureSize: 28,
    columnHead: { size: 8.5, tracking: 0.12 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = 14 * MM;
    const cx = A4.w / 2;
    const { left, right } = registrationLines(identity);
    let crestBottom;
    if (identity.logoBuffer || identity.monogram) {
      const h = identity.logoBuffer ? crestMark(R, cx, top, 46)
        : (crestMark(R, cx, top, 46), 46);
      R.text(identity.name, { font: "Times-Roman", size: 23, caps: true, tracking: 0.20, x: margin, y: top + 46 + 8, width: R.width, align: "center", advance: false });
      crestBottom = top + 46 + 8 + 23 * 1.05;
    } else {
      // Logo absent AND no monogram: the venue name at Times 28 in its place.
      R.text(identity.name, { font: "Times-Roman", size: 28, caps: true, tracking: 0.20, x: margin, y: top + 10, width: R.width, align: "center", advance: false });
      crestBottom = top + 10 + 28 * 1.05;
    }
    if (identity.tagline) {
      R.text(identity.tagline, { size: 8, caps: true, tracking: 0.30, color: R.T.mid, x: margin, y: crestBottom + 5, width: R.width, align: "center", advance: false });
      crestBottom += 5 + 9;
    }
    R.text(left.join("\n"), { size: 9.5, color: R.T.mid, tracking: 0.03, lineGap: 3.5, x: margin, y: top + 2, width: R.width * 0.3, advance: false });
    R.text(right.join("\n"), { size: 9.5, color: R.T.mid, lineGap: 3.5, x: margin + R.width * 0.7, y: top + 2, width: R.width * 0.3, align: "right", advance: false });
    return rulePair(R, margin, margin + R.width, crestBottom + 12);
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
    // centred-title language honours the shared anatomy rule rather than
    // centring a five-column document's opening
    const align = m.dense ? "left" : "center";
    R.text(m.eyebrow, { size: 8.5, caps: true, tracking: 0.28, color: R.T.accent, align });
    R.gap(9);
    R.text(m.title, { font: "Times-Roman", size: R.T.titleSize, align, lineGap: 2 });
    if (m.subject) { R.gap(8); R.text(m.subject, { size: TYPE.body, color: R.T.mid, align }); }
    if (m.refs && m.refs.length) {
      R.gap(16);
      const w = m.dense ? R.width : R.width * 0.66;
      const x = m.dense ? R.margin : R.margin + (R.width - w) / 2;
      R.rule(x, R.y, x + w, 0.5, R.T.hairline);
      R.gap(11);
      R.text(m.refs.join("      "), { size: TYPE.reference, tracking: 0.04, color: R.T.mid, x, width: w, align });
    }
  },
  frame() { /* identity */ },
  tableHead(R, { columns, colX, colW, x, width, y }) {
    const c = R.T.columnHead;
    columns.forEach((col, i) => {
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.mid, x: colX[i], y, width: colW[i] - (col.numeric ? 0 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    const yy = y + c.size + 6;
    R.rule(x, yy, x + width, 1, R.T.ink);
    return yy + 1;
  },
  emphasisBlock(R, draw, { x, width }) {
    const startY = R.y;
    R.gap(SPACE.panelPad);
    draw(x + SPACE.panelPad, width - SPACE.panelPad * 2);
    R.gap(SPACE.panelPad);
    R.box(x, startY, width, R.y - startY, { weight: 1.5, color: R.T.ink });
  },
  groupTreatment(R, kind, draw, estHeight) {
    if (kind === "refundable") {
      const y0 = R.y;
      R.rule(R.margin, y0, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(9);
      draw({ tagFilled: false });
      R.gap(9);
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(1);
    } else {
      R.measuredBlock(
        () => { R.gap(SPACE.panelPad); draw({ inset: 14 }); R.gap(SPACE.panelPad); },
        (y0, h) => {
          R.doc.save().rect(R.margin, y0, R.width, h).fill(R.T.tint);
          R.doc.rect(R.margin, y0, 3, h).fill(R.T.accent);
          R.doc.restore();
        }
      );
    }
  },
};

// ═══ LEDGER ══════════════════════════════════════════════════════════════════
const ledger = {
  name: "ledger",
  tokens: {
    ...classic.tokens,
    ruleWeights: { emphasis: 3, masthead: 1.5, tableTotal: 0.5, rowSep: 0.75, footer: 0.5 },
    fillPolicy: "rules", tint: null,
    titleSize: 40, heroSizes: { statement: 42, receipt: 44 }, totalFigureSize: 28,
    columnHead: { size: 8, tracking: 0.18 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = 14 * MM;
    const { left, right } = registrationLines(identity);
    // left crest stacked two lines, Times 19/0.13em
    let nameBottom;
    if (identity.logoBuffer) {
      crestMark(R, margin + 23, top, 46);
      nameBottom = top + 48;
    } else {
      const words = identity.name.split(" ");
      const l1 = words.slice(0, Math.ceil(words.length / 2)).join(" ");
      const l2 = words.slice(Math.ceil(words.length / 2)).join(" ");
      R.text(l1, { font: "Times-Roman", size: 19, caps: true, tracking: 0.13, x: margin, y: top, width: R.width * 0.34, advance: false });
      R.text(l2 || " ", { font: "Times-Roman", size: 19, caps: true, tracking: 0.13, x: margin, y: top + 21, width: R.width * 0.34, advance: false });
      nameBottom = top + 42;
    }
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
    // the 30% reference rail behind a 0.75px vertical rule
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
    // no box — a 3px ink top rule and open sides
    R.rule(x, R.y, x + width, 3, R.T.ink);
    R.gap(SPACE.panelPad);
    draw(x, width);
    R.gap(4);
  },
  groupTreatment(R, kind, draw, estHeight) {
    if (kind === "refundable") return classic.groupTreatment(R, kind, draw, estHeight);
    // extras: 0.75px accent left edge, NO fill (fillPolicy: rules only)
    const y0 = R.y;
    R.gap(SPACE.panelPad);
    draw({ inset: 14 });
    R.gap(SPACE.panelPad);
    R.vrule(R.margin, y0, R.y, 0.75, R.T.accent);
  },
};

// ═══ STATIONERY ══════════════════════════════════════════════════════════════
const stationery = {
  name: "stationery",
  tokens: {
    ...classic.tokens,
    pageMargin: 10, contentInset: 31.5,
    ruleWeights: { emphasis: 0.75, masthead: 0.5, tableTotal: 0.75, rowSep: 0.5, footer: 0.5 },
    fillPolicy: "rules", tint: null,
    titleSize: 34, heroSizes: { statement: 32, receipt: 54 }, totalFigureSize: 32, totalFigureSizeDense: 30,
    columnHead: { size: 8, tracking: 0.20 },
  },
  header(R) {
    const { identity, margin } = R;
    const top = R.T.pageMargin * MM + R.T.contentInset;
    const cx = A4.w / 2;
    let y = top;
    if (identity.logoBuffer) { crestMark(R, cx, y, 28); y += 34; }
    else if (identity.monogram) {
      R.box(cx - 14, y, 28, 28, { weight: 0.75, color: R.T.accent });
      R.doc.font("Times-Roman").fontSize(12).fillColor(R.T.accent);
      R.doc.text(identity.monogram, cx - 14, y + 9, { width: 28, align: "center", characterSpacing: trk(12, 0.08) });
      y += 34;
    }
    const nameSize = identity.logoBuffer || identity.monogram ? 23 : 28;
    R.text(identity.name, { font: "Times-Roman", size: nameSize, caps: true, tracking: 0.20, x: margin, y, width: R.width, align: "center", advance: false });
    y += nameSize * 1.05 + 6;
    const reg = [identity.legalName, ...(identity.addressLines || []), identity.pan ? `PAN ${identity.pan}` : null, identity.gstin ? `GSTIN ${identity.gstin}` : null].filter(Boolean).join(" · ");
    R.text(reg, { size: 8, caps: true, tracking: 0.18, color: R.T.mid, x: margin, y, width: R.width, align: "center", advance: false });
    return y + 12; // no bottom rule — the frame provides it
  },
  footer(R) {
    const y = A4.h - R.T.pageMargin * MM - R.T.contentInset - 14;
    R.rule(R.margin, y, R.margin + R.width, 0.5, R.T.hairline);
    R.text(`${footerLine(R.identity, R.meta)}   ·   ${WORDING.poweredBy}`, { size: 8.5, color: R.T.mid, x: R.margin, y: y + 6, width: R.width, align: "center", advance: false });
    return y;
  },
  titleBlock(R, m) {
    R.gap(6);
    // the eyebrow between two rules
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
    if (m.subject) { R.gap(6); R.text(m.subject, { font: "Times-Italic", size: 13, color: R.T.mid, align: "center" }); }
    if (m.refs && m.refs.length) {
      R.gap(10);
      R.text(m.refs.join("   ·   "), { size: TYPE.reference, tracking: 0.04, color: R.T.mid, align: "center" });
    }
  },
  frame(R) {
    // 0.75px accent border, 4px gap, second border — re-drawn on EVERY page
    const m = R.T.pageMargin * MM;
    R.doc.save();
    R.doc.rect(m, m, A4.w - m * 2, A4.h - m * 2).lineWidth(0.75).strokeColor(R.T.accent).stroke();
    R.doc.rect(m + 4.75, m + 4.75, A4.w - (m + 4.75) * 2, A4.h - (m + 4.75) * 2).lineWidth(0.75).strokeColor(R.T.accent).stroke();
    R.doc.restore();
  },
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
    const startY = R.y;
    R.gap(SPACE.panelPad);
    draw(x + SPACE.panelPad, width - SPACE.panelPad * 2);
    R.gap(SPACE.panelPad);
    R.box(x, startY, width, R.y - startY, { weight: 0.75, color: R.T.accent });
  },
  groupTreatment(R, kind, draw, estHeight) {
    if (kind === "refundable") return classic.groupTreatment(R, kind, draw, estHeight);
    return ledger.groupTreatment(R, kind, draw, estHeight); // accent left edge, no fill
  },
};

// ═══ PANEL ═══════════════════════════════════════════════════════════════════
const panel = {
  name: "panel",
  tokens: {
    ink: "#17150F", mid: "#6B6455", hairline: "#C9BFA8", accent: "#8A6A2F", tint: "#F1ECE0",
    reverseInk: "#17150F", reverseText: "#F4EFE2", gold: "#A08040", goldOnDark: "#D8B264", dim: "#9C937F", darkRule: "#4A4437",
    pageMargin: 0, contentInset: 16 * MM,
    ruleWeights: { emphasis: 3, masthead: 1, tableTotal: 0.75, rowSep: 0.5, footer: 0.5 },
    fillPolicy: "fills",
    titleSize: 32, heroSizes: { statement: 38, receipt: 44 }, totalFigureSize: 28,
    columnHead: { size: 8, tracking: 0.18 },
  },
  header(R) {
    // full-bleed reverseInk band, 20px × 16mm padding
    const { identity } = R;
    const padX = 16 * MM;
    const bandH = 84;
    R.doc.save().rect(0, 0, A4.w, bandH).fill(R.T.reverseInk).restore();
    if (identity.logoBuffer) {
      try { R.doc.image(identity.logoBuffer, padX, 20, { fit: [100, 44] }); } catch (_) { /* text fallback below */ }
      R.text(identity.name, { font: "Times-Roman", size: 16, caps: true, tracking: 0.16, color: R.T.reverseText, x: padX + 112, y: 30, width: R.width * 0.5, advance: false });
    } else {
      R.text(identity.name, { font: "Times-Roman", size: identity.monogram ? 21 : 24, caps: true, tracking: 0.18, color: R.T.reverseText, x: padX, y: 24, width: R.width * 0.6, advance: false });
      if (identity.tagline) R.text(identity.tagline, { size: 8, caps: true, tracking: 0.30, color: R.T.gold, x: padX, y: 52, width: R.width * 0.6, advance: false });
    }
    const { left, right } = registrationLines(identity);
    R.text([...left, ...right].join("  ·  "), { size: 9, color: R.T.dim, lineGap: 2.5, x: A4.w - padX - R.width * 0.42, y: 24, width: R.width * 0.42, align: "right", advance: false });
    return bandH;
  },
  footer(R) {
    const bandH = 34;
    const y = A4.h - bandH;
    R.doc.save().rect(0, y, A4.w, bandH).fill(R.T.tint).restore();
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
    const c = R.T.columnHead;
    const h = c.size + 12;
    R.doc.save().rect(x, y, width, h).fill(R.T.reverseInk).restore();
    columns.forEach((col, i) => {
      const inset = i === 0 ? 12 : 0;
      R.text(col.label, { size: c.size, caps: true, tracking: c.tracking, color: R.T.goldOnDark, x: colX[i] + inset, y: y + 6, width: colW[i] - inset - (col.numeric ? 12 : 6), align: col.numeric ? "right" : "left", advance: false });
    });
    return y + h + 2;
  },
  // emphasisBlock assigned below — the tint slab with a 3px ink left edge
  // (§3: the reversed block is reserved for the one number a document
  // exists for), painted via measuredBlock so the slab is never short.
  emphasisBlock: null,
  groupTreatment(R, kind, draw, estHeight) {
    if (kind === "refundable") {
      const y0 = R.y;
      R.rule(R.margin, y0, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(9);
      draw({ tagFilled: true });
      R.gap(9);
      R.rule(R.margin, R.y, R.margin + R.width, 0.75, R.T.accent, 3);
      R.gap(1);
    } else {
      return classic.groupTreatment.call(this, R, kind, draw, estHeight);
    }
  },
};

// Panel's emphasisBlock must paint its slab BEFORE the content. Replace with
// a measured two-pass: estimate via a dry layout is overkill — draw the slab
// after by saving the region is wrong. Simplest correct: draw fill first
// using the estHeight the caller supplies through R.emphasisBlock's ensure.
panel.emphasisBlock = function emphasisBlock(R, draw, { x, width }) {
  R.measuredBlock(
    () => { R.gap(SPACE.panelPad); draw(x + SPACE.panelPad + 4, width - SPACE.panelPad * 2 - 4); R.gap(SPACE.panelPad); },
    (y0, h) => {
      R.doc.save().rect(x, y0, width, h).fill(panel.tokens.tint).restore();
      R.doc.save().rect(x, y0, 3, h).fill(panel.tokens.ink).restore();
    }
  );
};

const LANGUAGES = { classic, ledger, stationery, panel };
const LANGUAGE_NAMES = Object.keys(LANGUAGES);

module.exports = { LANGUAGES, LANGUAGE_NAMES };

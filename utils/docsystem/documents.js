/**
 * utils/docsystem/documents.js — the five documents, over the one renderer.
 *
 * Each builder receives ASSEMBLED data (assemble.js) and an Engine. Section
 * order per document is fixed (LANGUAGES.md §1 anatomy); a language re-draws
 * sections through its recipes, it may not re-order, add or drop them. No
 * function here reads a colour, a size the language owns, or the language
 * name.
 */
const { Engine } = require("./engine");
const {
  TYPE, SPACE, DASH,
  money, moneyOrDash, dateProse, dateCell, dateTimeProse, amountInWords, WORDING,
  bankLines,
} = require("./shared");

/**
 * One label/value row in a totals stack. Measures BOTH sides and advances by
 * the taller — the statement's closing box shipped overprinting itself
 * because a local helper advanced by a fixed 6px (walkthrough finding).
 */
function kvRow(R, { x, width, label, value, figure = false, mid = false, gapAfter, figureSize, bold = false }) {
  const size = figure ? (figureSize || R.T.totalFigureSize) : TYPE.body;
  const labelSize = figure ? TYPE.totalLabel : TYPE.body;
  const labelFont = figure ? "Times-Roman" : "Helvetica";
  const valueFont = figure ? "Times-Roman" : bold ? "Helvetica-Bold" : "Helvetica";
  // A FIGURE value takes the full measure right-aligned — "Rs. 14,82,500" at
  // Times 28 must never wrap in a narrow stack (it shipped wrapping, caught
  // on the confirmation's agreed-amount box). The label is short by contract.
  const labelW = figure ? width * 0.42 : width * 0.55;
  const valueW = figure ? width : width * 0.45;
  const h = Math.max(
    R.measure(label, { font: labelFont, size: labelSize, width: labelW }),
    R.measure(value, { font: valueFont, size, width: valueW })
  );
  R.text(label, { font: labelFont, size: labelSize, color: mid ? R.T.mid : R.T.ink, x, y: R.y + (figure ? Math.max(0, (size - labelSize) * 0.6) : 0), width: labelW, advance: false });
  R.text(value, { font: valueFont, size, x: figure ? x : x + width * 0.45, y: R.y, width: valueW, align: "right", advance: false });
  R.y += h + (gapAfter !== undefined ? gapAfter : 6);
}

// ── treatment sub-lines (fixed wording shapes from the handoff) ─────────────
function treatmentSubLine(l) {
  if (l.refundable) return "Held and returned — not charged as revenue";
  if (l.treatment === "full") return "GST on the full amount";
  if (l.treatment === "part") {
    const balance = l.amount - l.taxable;
    return `GST on ${money(l.taxable)} of this line; the balance ${money(balance)} is not taxable`;
  }
  return "No GST";
}
function treatmentCell(l) {
  if (l.treatment === "full") return "Full amount";
  if (l.treatment === "part") return `Part — taxable ${money(l.taxable)}`;
  return "No GST";
}

// ── the priced line table (two contract variants) ───────────────────────────
const LINE_COLUMNS = (pct) => [
  { key: "line", label: "Line", width: 0.47 },
  { key: "amount", label: "Amount", width: 0.13, numeric: true },
  { key: "taxable", label: "Taxable", width: 0.13, numeric: true },
  { key: "gst", label: `GST ${pct}%`, width: 0.12, numeric: true },
  { key: "total", label: "Line total", width: 0.15, numeric: true },
];
const DENSE_LINE_COLUMNS = (pct) => [
  { key: "line", label: "Line", width: 0.34 },
  { key: "treatment", label: "GST treatment", width: 0.24 },
  { key: "amount", label: "Amount", width: 0.13, numeric: true },
  { key: "gst", label: `GST ${pct}%`, width: 0.13, numeric: true },
  { key: "total", label: "Line total", width: 0.16, numeric: true },
];

function pricedLinesTable(R, priced, totals, { dense = false } = {}) {
  const columns = dense ? DENSE_LINE_COLUMNS(totals.pct) : LINE_COLUMNS(totals.pct);
  const rows = priced.map((l, i) => ({
    cells: dense ? {
      line: { text: l.label },
      treatment: { text: treatmentCell(l), color: R.T.mid, size: TYPE.subLine + 0.5 },
      amount: money(l.amount).replace("Rs. ", ""),
      gst: l.gst ? money(l.gst).replace("Rs. ", "") : DASH,
      total: money(l.lineTotal).replace("Rs. ", ""),
    } : {
      line: { text: l.label, subLine: treatmentSubLine(l) },
      amount: money(l.amount).replace("Rs. ", ""),
      taxable: l.taxable ? money(l.taxable).replace("Rs. ", "") : DASH,
      gst: l.gst ? money(l.gst).replace("Rs. ", "") : DASH,
      total: money(l.lineTotal).replace("Rs. ", ""),
    },
    lastData: i === priced.length - 1,
  }));
  rows.push({
    kind: "subtotal",
    cells: dense ? {
      line: { text: WORDING.chargedSubtotal, caps: true, size: 9, color: R.T.mid },
      amount: { text: money(totals.charged).replace("Rs. ", ""), bold: true },
      gst: { text: money(totals.gst).replace("Rs. ", ""), bold: true },
      total: { text: money(totals.charged + totals.gst).replace("Rs. ", ""), bold: true },
    } : {
      line: { text: WORDING.chargedSubtotal, caps: true, size: 9, color: R.T.mid },
      amount: { text: money(totals.charged).replace("Rs. ", ""), bold: true },
      taxable: { text: money(totals.taxable).replace("Rs. ", ""), bold: true },
      gst: { text: money(totals.gst).replace("Rs. ", ""), bold: true },
      total: { text: money(totals.charged + totals.gst).replace("Rs. ", ""), bold: true },
    },
  });
  R.table({ columns, rows, cellSize: dense ? TYPE.denseCell : TYPE.cell });
}

// ── the refundable band ─────────────────────────────────────────────────────
function refundableBand(R, refundables) {
  if (!refundables.length) return;
  R.gap(10);
  // No tag, no border, no fill (the revision's governing rule): the word
  // "Refundable —" is an accent lead-in to the description, and the band is
  // marked by the dashed accent rules the groupTreatment draws.
  R.refundableBand(() => {
    for (const l of refundables) {
      const y0 = R.y;
      const leadIn = "Refundable — ";
      R.text(leadIn, { size: 8.5, caps: true, tracking: 0.16, color: R.T.accent, x: R.margin, y: y0 + 2, width: 96, advance: false });
      R.text(l.label, { size: TYPE.cell, x: R.margin + 96, y: y0, width: R.width - 96 - 120, advance: false });
      R.text(money(l.amount).replace("Rs. ", ""), { size: TYPE.cell, x: R.margin + R.width - 120, y: y0, width: 120, align: "right", advance: false });
      R.gap(16);
      R.text(treatmentSubLine(l), { size: TYPE.subLine, color: R.T.mid, x: R.margin + 96, width: R.width - 96 });
    }
  }, 40 * refundables.length);
}

// ── the totals stack (quote/confirmation flavour) ───────────────────────────
function totalsStack(R, totals, x, width) {
  const row = (label, value, opts = {}) => kvRow(R, { x, width, label, value, ...opts });
  row("Charged", money(totals.charged), { mid: true });
  if (totals.extrasAmount) row("Extras", money(totals.extrasAmount), { mid: true });
  if (totals.refundable) row("Refundable deposit", money(totals.refundable), { mid: true });
  R.gap(6);
  // THE HERO FOLLOWS THE FACTS (founder ruling, confirmdoc2 finding 6).
  // With GST, the number the couple transfers is "Total including GST" —
  // standard Indian invoice phrasing, explaining its own arithmetic against
  // the Total payable line above it — and IT takes the language's
  // emphasisBlock and the Times figure. With no GST anywhere, Total payable
  // IS that number: the emphasis moves onto it and nothing repeats it
  // beneath — a line repeating a figure already on screen is a figure with
  // nothing to add (the no-GST line echo's rule). "Total payable" and the
  // refundable-held sentence stay verbatim in both cases; nothing enclosed.
  const refundableSub = (px, pw) => {
    if (!totals.refundable) return;
    R.text(WORDING.refundableHeld(totals.refundable), { size: TYPE.subLine, color: R.T.mid, x: px, width: pw });
    R.gap(4);
  };
  const gstAll = totals.gst + totals.extrasGst;
  if (gstAll > 0) {
    row(WORDING.totalPayable, money(totals.payable), { gapAfter: 4 });
    refundableSub(x, width);
    R.gap(4);
    R.text(WORDING.gstSentence(totals.taxable, totals.gst), { size: TYPE.fine, color: R.T.mid, x, width, lineGap: 3 });
    if (totals.extrasGst) {
      R.gap(4);
      R.text(WORDING.gstSentence(extrasTaxableOf(totals), totals.extrasGst, "the extras"), { size: TYPE.fine, color: R.T.mid, x, width, lineGap: 3 });
    }
    R.gap(8);
    R.emphasisBlock((bx, bw) => {
      kvRow(R, { x: bx, width: bw, label: WORDING.totalIncludingGst, value: money(totals.collectable), figure: true, gapAfter: 4 });
    }, { x, width, estHeight: 52 });
  } else {
    R.emphasisBlock((bx, bw) => {
      kvRow(R, { x: bx, width: bw, label: WORDING.totalPayable, value: money(totals.payable), figure: true, gapAfter: 4 });
      refundableSub(bx, bw);
    }, { x, width, estHeight: 72 });
  }
  R.rule(x, R.y, x + width, 0.75, R.T.hairline);
}
const extrasTaxableOf = (totals) => Math.round(totals.extrasGst / 0.18);

// ── the schedule table ──────────────────────────────────────────────────────
function scheduleColumns(withState) {
  const cols = [
    { key: "instalment", label: "Instalment", width: withState ? 0.30 : 0.34 },
    { key: "due", label: "Due", width: 0.14 },
    { key: "payable", label: "Payable", width: withState ? 0.14 : 0.16, numeric: true },
    { key: "gst", label: "GST", width: withState ? 0.12 : 0.16, numeric: true },
    { key: "collectable", label: "Collectable", width: withState ? 0.15 : 0.20, numeric: true },
  ];
  if (withState) cols.push({ key: "state", label: "State", width: 0.15, align: "right" });
  return cols;
}

function scheduleTable(R, schedule, totals, { withState = false, payments = null } = {}) {
  // PROVEN, NOT PRINTED: the "Sums exactly" row's figures are asserted
  // against the rows above it before anything is drawn. A schedule that does
  // not add up must fail generation, never ship a false sentence.
  const sumPayable = schedule.reduce((s2, r) => s2 + r.payable, 0);
  const sumGst = schedule.reduce((s2, r) => s2 + r.gst, 0);
  const sumCollectable = schedule.reduce((s2, r) => s2 + r.collectable, 0);
  if (sumPayable !== totals.payable || sumGst !== totals.gst + totals.extrasGst || sumCollectable !== totals.collectable) {
    throw new Error(
      `schedule does not sum to totals: payable ${sumPayable}/${totals.payable}, ` +
      `gst ${sumGst}/${totals.gst + totals.extrasGst}, collectable ${sumCollectable}/${totals.collectable}`
    );
  }
  // …AND THE LABEL IS PROVEN TOO. "Sums exactly to total payable" once named
  // the wrong figure: a caller handed doctored totals whose "payable" held the
  // collectable, the arithmetic matched the doctored object, and the word
  // pointed at a number ₹36,000 away from the document's own Total payable.
  // The row's figure must satisfy the DEFINITION of the label it prints —
  // payable = charged + refundable + extras, collectable = payable + GST
  // (LANGUAGES.md §1) — so a relabeled figure fails generation the same way a
  // wrong sum does.
  if (totals.payable !== totals.charged + totals.refundable + totals.extrasAmount
    || totals.collectable !== totals.payable + totals.gst + totals.extrasGst) {
    throw new Error(
      `schedule totals violate the fixed definitions: payable ${totals.payable} vs ` +
      `charged ${totals.charged} + refundable ${totals.refundable} + extras ${totals.extrasAmount}; ` +
      `collectable ${totals.collectable} vs payable + gst ${totals.gst + totals.extrasGst}`
    );
  }
  const columns = scheduleColumns(withState);
  const rows = [];
  schedule.forEach((r, i) => {
    const cells = {
      instalment: { text: r.label, subLine: r.subLine || (r.refundableCarried ? `Includes the refundable deposit of ${money(r.refundableCarried)}` : undefined) },
      due: r.dueLabel || dateCell(r.dueDate),
      payable: money(r.payable).replace("Rs. ", ""),
      gst: r.gst ? money(r.gst).replace("Rs. ", "") : DASH,
      collectable: money(r.collectable).replace("Rs. ", ""),
    };
    if (withState) cells.state = { text: r.state || "Upcoming", size: TYPE.subLine + 0.5, color: r.state === "Late" ? R.T.accent : R.T.mid, bold: r.state === "Late" };
    rows.push({ cells, lastData: i === schedule.length - 1 && !(payments && payments.length) });
    if (payments) {
      for (const p of payments.filter((p2) => String(p2.rowRef) === String(r.ref))) {
        rows.push({ kind: "sub", cells: { instalment: { text: p.text, indent: 14 }, collectable: p.amountText ? { text: p.amountText } : undefined } });
      }
    }
  });
  rows.push({
    kind: "total",
    cells: {
      instalment: { text: WORDING.sumsExactly, caps: true, size: 9, color: R.T.mid },
      payable: { text: money(totals.payable).replace("Rs. ", ""), bold: true },
      gst: { text: money(totals.gst + totals.extrasGst).replace("Rs. ", ""), bold: true },
      collectable: { text: money(totals.collectable).replace("Rs. ", ""), bold: true },
    },
  });
  R.table({ columns, rows });
}

// ── the payment block: where the money goes ─────────────────────────────────
// Founder placement ruling: beside the schedule on a quote and a confirmation
// (the section that says WHEN to pay says WHERE), by the amount due on the
// invoice (the designed remit slot), after the reconciliation on a statement.
// NEVER on the receipt — that confirms money already arrived. Renders only
// when the venue filled something (R.identity.bank is null otherwise): no
// heading, no empty rows. Fixed content over tokens; nothing enclosed.
function paymentBlock(R) {
  const bank = R.identity.bank;
  if (!bank) return;
  const lines = bankLines(bank);
  if (!lines.length) return;
  R.ensure(30 + lines.length * 15);
  R.gap(14);
  R.text("Payment details", { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.mid });
  R.gap(4);
  for (const line of lines) {
    R.text(line, { size: TYPE.subLine + 1, color: R.T.mid, lineGap: 2 });
    R.gap(2);
  }
}

// ── the fact strip ──────────────────────────────────────────────────────────
function factStrip(R, facts) {
  if (!facts || !facts.length) return;
  R.gap(SPACE.block);
  const y0 = R.y;
  const wEach = R.width / facts.length;
  let maxH = 0;
  facts.forEach((f, i) => {
    const x = R.margin + wEach * i + (i ? 14 : 0);
    const w = wEach - (i ? 14 : 0) - 8;
    R.text(f.label, { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.mid, x, y: y0 + 9, width: w, advance: false });
    const h = R.text(f.value, { size: 13, x, y: y0 + 9 + 12, width: w, advance: false });
    maxH = Math.max(maxH, 9 + 12 + h + 9);
    if (i) R.vrule(R.margin + wEach * i, y0 + 6, y0 + maxH - 4, 0.75, R.T.hairline);
  });
  R.rule(R.margin, y0, R.margin + R.width, 0.75, R.T.hairline);
  R.rule(R.margin, y0 + maxH, R.margin + R.width, 0.75, R.T.hairline);
  R.y = y0 + maxH;
}

// ── note + signature closing row ────────────────────────────────────────────
function closingRow(R, noteLines, signatory) {
  const notes = noteLines.filter(Boolean);
  if (!notes.length && !signatory) return;
  // Without a signatory there is no signature line — the bare rule shipped on
  // its own once, reading as a totals block that had lost its content — and
  // the closing is only as tall as its notes, so two sentences never claim a
  // second sheet by reservation alone.
  R.ensure(signatory ? 84 : 44);
  R.gap(22);
  const y0 = R.y;
  const noteW = signatory ? R.width * 0.6 : R.width * 0.74;
  let leftH = 0;
  for (const n of notes) {
    leftH += R.text(n, { size: TYPE.fine, color: R.T.mid, lineGap: 3, x: R.margin, y: y0 + leftH, width: noteW, advance: false }) + 6;
  }
  if (signatory) {
    const sx = R.margin + R.width * 0.66;
    const sw = R.width * 0.34;
    R.rule(sx, y0 + 26, sx + sw, 0.75, R.T.ink);
    R.text(signatory.name, { size: TYPE.cell, x: sx, y: y0 + 32, width: sw, advance: false });
    if (signatory.role) R.text(signatory.role, { size: TYPE.subLine, color: R.T.mid, x: sx, y: y0 + 47, width: sw, advance: false });
  }
  R.y = y0 + Math.max(leftH, signatory ? 60 : 0);
}

// ── the parties block: venue left, client right, as Indian tax documents read ─
// Fixed content over language tokens (the factStrip pattern): open 0.75px
// rules above and below, nothing enclosed. Each side prints only the facts
// that exist — client address and GSTIN are not collected anywhere today, so
// those lines simply do not render until the collection step lands.
function partiesBlock(R, parties) {
  if (!parties) return;
  R.gap(SPACE.block);
  const y0 = R.y;
  const half = R.width / 2;
  const side = (x, w, label, p) => {
    if (!p || (!p.name && !(p.lines || []).length)) return 0;
    let y = y0 + 9;
    R.text(label, { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.mid, x, y, width: w, advance: false });
    y += 13;
    if (p.name) {
      y += R.text(p.name, { size: TYPE.body, x, y, width: w, advance: false }) + 2;
    }
    for (const line of p.lines || []) {
      y += R.text(line, { size: TYPE.subLine + 1, color: R.T.mid, x, y, width: w, advance: false }) + 2;
    }
    return y - y0 + 7;
  };
  const hL = side(R.margin, half - 14, "The venue", parties.venue);
  const hR = side(R.margin + half + 14, half - 14, "The client", parties.client);
  const maxH = Math.max(hL, hR);
  if (!maxH) { R.y = y0; return; }
  R.vrule(R.margin + half, y0 + 6, y0 + maxH - 4, 0.75, R.T.hairline);
  R.rule(R.margin, y0, R.margin + R.width, 0.75, R.T.hairline);
  R.rule(R.margin, y0 + maxH, R.margin + R.width, 0.75, R.T.hairline);
  R.y = y0 + maxH;
}

// ═══ 1. QUOTE ════════════════════════════════════════════════════════════════
async function renderQuote(R, d) {
  R.L.titleBlock(R, d.titleMeta);
  factStrip(R, d.facts);
  R.sectionLabel("Quoted lines");
  pricedLinesTable(R, d.priced, d.totals);
  refundableBand(R, d.refundables);
  // inclusions (left) + totals stack (right 46%)
  R.gap(SPACE.block);
  R.ensure(210);
  const y0 = R.y;
  const rightW = R.width * 0.46;
  const leftW = R.width - rightW - 18;
  let leftBottom = y0;
  if (d.inclusions && d.inclusions.length) {
    // plain — nothing is enclosed: a small-caps label and the list
    R.text("What the price includes", { size: 8.5, caps: true, tracking: 0.2, color: R.T.mid, x: R.margin, width: leftW });
    R.gap(8);
    for (const inc of d.inclusions) {
      R.text(inc, { size: TYPE.cell, lineGap: 4, x: R.margin, width: leftW });
      R.gap(3);
    }
    leftBottom = R.y;
  }
  R.y = y0;
  totalsStack(R, d.totals, R.margin + R.width - rightW, rightW);
  R.y = Math.max(R.y, leftBottom);
  R.sectionLabel("Booking amount & instalment plan");
  scheduleTable(R, d.schedule, d.totals);
  paymentBlock(R);
  closingRow(R, d.noteLines, d.signatory);
}

// ═══ 2. BOOKING CONFIRMATION ═════════════════════════════════════════════════
// Full width, sequential — every document in the world lists prices one after
// another: parties → event facts → spaces & rooms → the agreed lines →
// totals → schedule. The two half-empty side panels are gone; full measure
// lets the spaces-and-rooms section grow with the booking.
async function renderConfirmation(R, d) {
  R.L.titleBlock(R, d.titleMeta);
  if (d.intro) {
    R.gap(6);
    R.text(d.intro, { size: TYPE.body, color: R.T.mid, x: R.margin + R.width * 0.13, width: R.width * 0.74, align: "center", lineGap: 3 });
  }
  partiesBlock(R, d.parties);
  factStrip(R, d.facts);
  // BOOKING 3 ruling: no recorded allocation → the document says NOTHING
  // about rooms — the heading included. "Spaces & rooms" naming rooms it
  // then stays silent about is a claim with no rows under it.
  R.sectionLabel(d.rooms && d.rooms.length ? "Spaces & rooms" : "Spaces");
  const srRows = [...(d.spaces || []), ...(d.rooms || [])];
  R.table({
    cellSize: TYPE.cell,
    columns: [
      { key: "space", label: "Allocated", width: 0.64 },
      { key: "detail", label: "Detail", width: 0.36, align: "right" },
    ],
    rows: srRows.map((s, i) => ({ cells: { space: s.name, detail: { text: s.detail || DASH, color: R.T.mid } }, lastData: i === srRows.length - 1 })),
  });
  R.sectionLabel("The agreed lines");
  pricedLinesTable(R, d.priced, d.totals);
  refundableBand(R, d.refundables);
  if (d.inclusions && d.inclusions.length) {
    R.gap(12);
    R.text("Included in the agreed amount", { size: 8.5, caps: true, tracking: 0.2, color: R.T.mid });
    R.gap(8);
    for (const inc of d.inclusions) {
      R.text(inc, { size: TYPE.cell, lineGap: 4 });
      R.gap(3);
    }
  }
  R.gap(SPACE.block);
  R.ensure(240);
  // no emphasis wrapper around the WHOLE stack — the emphasis belongs to
  // Total payable itself, and totalsStack now asks the language for it there
  R.text("The agreed amount", { font: "Times-Italic", size: TYPE.sectionLabel });
  R.gap(8);
  totalsStack(R, d.totals, R.margin, R.width);
  R.gap(8);
  R.text("Anything added after this confirmation is an extra: it is billed as its own group and never changes the agreed amount above.", { size: TYPE.fine, color: R.T.mid, lineGap: 3 });
  if (d.specialRequirements) {
    R.gap(10);
    R.text(`Special requirements — ${d.specialRequirements}`, { size: TYPE.fine, color: R.T.mid, lineGap: 3 });
  }
  R.sectionLabel("Payment schedule");
  scheduleTable(R, d.schedule, d.totals, { withState: true });
  if (d.received > 0) {
    R.gap(8);
    R.text(
      `Received so far: ${money(d.received)}. Balance due: ${money(d.balance)}.`,
      { size: TYPE.fine, color: R.T.mid, lineGap: 3 }
    );
  }
  paymentBlock(R);
  if (d.policyLines && d.policyLines.length) {
    R.sectionLabel("Cancellation policy");
    for (const line of d.policyLines) {
      R.ensure(30);
      R.text(line, { size: TYPE.fine, color: R.T.mid, lineGap: 3 });
      R.gap(5);
    }
  }
  closingRow(R, d.noteLines, d.signatory);
}

// ═══ 3. TAX INVOICE ══════════════════════════════════════════════════════════
async function renderInvoice(R, d) {
  R.L.titleBlock(R, d.titleMeta);
  factStrip(R, d.facts); // billed to / supply / against
  R.sectionLabel("Invoiced lines");
  // THE ORDINARY INVOICE (GST-first): same anatomy, NO tax columns — the
  // taxed/untaxed split exists precisely so this document never mentions the
  // GST register. Three columns; the tax-invoice shape keeps all six.
  const columns = d.plain
    ? [
        { key: "particulars", label: "Particulars", width: 0.60 },
        { key: "amount", label: "Amount", width: 0.20, numeric: true },
        { key: "total", label: "Total", width: 0.20, numeric: true },
      ]
    : [
        { key: "particulars", label: "Particulars", width: 0.40 },
        { key: "amount", label: "Amount", width: 0.12, numeric: true },
        { key: "taxable", label: "Taxable value", width: 0.13, numeric: true },
        { key: "cgst", label: `CGST ${d.sum.pctHalf}%`, width: 0.11, numeric: true },
        { key: "sgst", label: `SGST ${d.sum.pctHalf}%`, width: 0.11, numeric: true },
        { key: "total", label: "Total", width: 0.13, numeric: true },
      ];
  const rows = d.items.map((it, i) => ({
    cells: {
      particulars: { text: it.label, subLine: it.subLine },
      amount: money(it.amount).replace("Rs. ", ""),
      ...(d.plain ? {} : {
        taxable: it.taxable ? money(it.taxable).replace("Rs. ", "") : DASH,
        cgst: it.gst ? money(it.cgst).replace("Rs. ", "") : DASH,
        sgst: it.gst ? money(it.sgst).replace("Rs. ", "") : DASH,
      }),
      total: money(it.total).replace("Rs. ", ""),
    },
    lastData: i === d.items.length - 1,
  }));
  rows.push({
    kind: "total",
    cells: {
      particulars: { text: "Invoice total", bold: true },
      amount: { text: money(d.sum.amount).replace("Rs. ", ""), bold: true },
      ...(d.plain ? {} : {
        taxable: { text: money(d.sum.taxable).replace("Rs. ", ""), bold: true },
        cgst: { text: money(d.sum.cgst).replace("Rs. ", ""), bold: true },
        sgst: { text: money(d.sum.sgst).replace("Rs. ", ""), bold: true },
      }),
      total: { text: money(d.sum.total).replace("Rs. ", ""), bold: true },
    },
  });
  R.table({ columns, rows });
  R.gap(SPACE.block);
  R.ensure(240);
  const y0 = R.y;
  const rightW = R.width * 0.42;
  const leftW = R.width - rightW - 18;
  // left: tax working + fixed notes + words
  if (!d.plain) {
    R.text(WORDING.gstSentence(d.sum.taxable, d.sum.cgst + d.sum.sgst, "this invoice's lines"), { size: TYPE.fine, color: R.T.mid, width: leftW, lineGap: 3 });
    R.gap(8);
  }
  R.text(WORDING.neverInvoiced, { size: TYPE.fine, color: R.T.mid, width: leftW, lineGap: 3 });
  R.gap(10);
  R.text("Amount in words", { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.mid, width: leftW });
  R.gap(3);
  R.text(amountInWords(d.sum.total), { size: TYPE.fine, width: leftW, lineGap: 3 });
  const leftBottom = R.y;
  R.y = y0;
  R.emphasisBlock((x, w) => {
    const line = (label, value, mid) => kvRow(R, { x, width: w, label, value, mid, gapAfter: 4 });
    if (!d.plain) {
      line("Taxable value", money(d.sum.taxable), true);
      if (d.sum.nonTaxable) line("Non-taxable recoveries", money(d.sum.nonTaxable), true);
      line(`CGST ${d.sum.pctHalf}% + SGST ${d.sum.pctHalf}%`, money(d.sum.cgst + d.sum.sgst), true);
      R.gap(4);
    }
    kvRow(R, { x, width: w, label: "Amount due", value: money(d.sum.total), figure: true, gapAfter: 4 });
    if (d.dueDate) R.text(`Due ${dateProse(d.dueDate)}`, { size: TYPE.subLine, color: R.T.mid, x, width: w });
    if (d.remit) {
      R.gap(10);
      R.rule(x, R.y, x + w, 0.75, R.T.hairline);
      R.gap(8);
      R.text("Remit to", { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.mid, x, width: w });
      R.gap(3);
      R.text(d.remit, { size: TYPE.subLine, color: R.T.mid, lineGap: 3, x, width: w });
    }
  }, { x: R.margin + R.width - rightW, width: rightW, estHeight: 220 });
  R.y = Math.max(R.y, leftBottom);
  closingRow(R, d.noteLines, d.signatory);
}

// ═══ 4. STATEMENT OF ACCOUNT ═════════════════════════════════════════════════
async function renderStatement(R, d) {
  R.L.titleBlock(R, { ...d.titleMeta, dense: true });
  // top band: collectable / received / OUTSTANDING (the hero)
  R.gap(14);
  R.ensure(120);
  {
    // the position line — open sides, nothing enclosed, the hero is the
    // Times figure. The rule ABOVE is the LANGUAGE'S emphasisBlock, not a
    // weight copied across: LANGUAGES.md §3 says the one number each
    // document exists for "is carried by a 3px ink rule and the Times
    // figure" on Panel — hand-rolled 0.75s here gave every language
    // Classic's voice. A 0.75 ink rule still closes the line below.
    const x = R.margin, w = R.width;
    R.emphasisBlock((bx, bw) => {
      R.gap(2);
      const y0 = R.y;
      const widths = [0.34, 0.30, 0.36];
      let cx = bx;
      const cell = (i, label, figure, sub, hero) => {
        const cw = bw * widths[i] - 14;
        R.text(label, { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: hero ? R.T.ink : R.T.mid, x: cx, y: y0, width: cw, advance: false });
        R.text(figure, { font: "Times-Roman", size: hero ? R.T.heroSizes.statement : 24, x: cx, y: y0 + 13, width: cw, advance: false });
        if (sub) R.text(sub, { size: TYPE.subLine, color: hero && d.overdueTotal ? R.T.accent : R.T.mid, x: cx, y: y0 + 13 + (hero ? R.T.heroSizes.statement : 24) + 4, width: cw, advance: false });
        cx += bw * widths[i];
      };
      cell(0, "Total collectable", money(d.totals.collectable), `Agreed ${money(d.totals.charged + d.totals.refundable + d.totals.gst)} + extras ${money(d.totals.extrasAmount + d.totals.extrasGst)}`);
      cell(1, "Received to date", money(d.received), d.receivedSub);
      cell(2, "Outstanding", money(d.outstanding), d.overdueTotal ? `${money(d.overdueTotal)} of this is overdue` : "Nothing overdue", true);
      R.y = y0 + Math.max(R.T.heroSizes.statement, 24) + 30;
    }, { x, width: w, estHeight: 110 });
    R.rule(x, R.y, x + w, 0.75, R.T.ink);
    R.gap(2);
  }
  R.sectionLabel(`The agreed lines — fixed at booking, ${dateProse(d.bookedOn)}`);
  R.text("Unchanged since the booking was confirmed", { size: TYPE.subLine, color: R.T.mid });
  R.gap(8);
  pricedLinesTable(R, d.priced, d.totals, { dense: true });
  refundableBand(R, d.refundables);
  if (d.extras && d.extras.length) {
    R.sectionLabel("Additional billing", { color: R.T.accent });
    R.extrasGroup(() => {
      R.text(WORDING.extrasCaption, { size: TYPE.subLine, color: R.T.mid, x: R.margin + 14, width: R.width - 28 });
      R.gap(8);
      for (const e of d.extras) {
        const y0 = R.y;
        R.text(e.label, { size: TYPE.cell, x: R.margin + 14, y: y0, width: R.width - 28 - 260, advance: false });
        R.text(e.gst ? `GST ${money(e.gst)}` : "No GST", { size: TYPE.subLine, color: R.T.mid, x: R.margin + R.width - 260, y: y0 + 2, width: 120, align: "right", advance: false });
        R.text(money(e.amount).replace("Rs. ", ""), { size: TYPE.cell, x: R.margin + R.width - 134, y: y0, width: 120, align: "right", advance: false });
        R.gap(19);
      }
      R.rule(R.margin + 14, R.y, R.margin + R.width - 14, 0.75, R.T.hairline);
      R.gap(6);
      const ty = R.y;
      R.text("Extras total", { size: TYPE.cell, bold: true, font: "Helvetica-Bold", x: R.margin + 14, y: ty, width: 200, advance: false });
      R.text(d.totals.extrasGst ? `${money(d.totals.extrasAmount)} + ${money(d.totals.extrasGst)} GST` : money(d.totals.extrasAmount), { font: "Helvetica-Bold", size: TYPE.cell, x: R.margin + R.width - 274, y: ty, width: 260, align: "right", advance: false });
      R.gap(18);
    }, 60 + d.extras.length * 20);
  }
  R.sectionLabel("Schedule & payments received");
  scheduleTable(R, d.schedule, d.totals, { withState: true, payments: d.paymentSubRows });
  // ── THE CLOSING RECONCILIATION — full measure, never beside the notes ──
  // "How the outstanding figure is arrived at": one hairline row per step,
  // the GST and Received rows stating their basis inline. Outstanding is at
  // display size here and at the position line — exactly twice per document
  // (Stationery states it once: heroSizes.statementClosing is null there and
  // the row's figure stays at body weight).
  R.gap(SPACE.block);
  R.ensure(260);
  R.text("How the outstanding figure is arrived at", { font: "Times-Italic", size: 15 });
  R.gap(9);
  R.emphasisBlock((x, w) => {
    const step = (label, value, opts = {}) => {
      kvRow(R, { x, width: w, label, value, ...opts });
      if (!opts.noRule) { R.rule(x, R.y - 3, x + w, 0.5, R.T.hairline); R.gap(3); }
    };
    step("Charged — agreed lines", money(d.totals.charged));
    if (d.totals.extrasAmount) step("Extras added since booking", money(d.totals.extrasAmount));
    if (d.totals.refundable) step("Refundable deposit held", money(d.totals.refundable));
    kvRow(R, { x, width: w, label: WORDING.totalPayable, value: money(d.totals.payable), figure: true, figureSize: 26, gapAfter: 3 });
    if (d.totals.refundable) {
      R.text(WORDING.refundableHeld(d.totals.refundable), { size: TYPE.subLine, color: R.T.mid, x, width: w });
      R.gap(7);
    }
    R.rule(x, R.y - 3, x + w, 0.5, R.T.hairline); R.gap(3);
    step(`GST at ${d.totals.pct}% — on the taxable ${money(d.totals.taxable + Math.round(d.totals.extrasGst / 0.18))} of the lines and extras`, money(d.totals.gst + d.totals.extrasGst));
    step(`Received to date — ${d.receivedSub}`, `- ${money(d.received)}`);
    kvRow(R, {
      x, width: w, label: "Outstanding", value: money(d.outstanding),
      figure: Boolean(R.T.heroSizes.statementClosing),
      figureSize: R.T.heroSizes.statementClosing || undefined,
      bold: !R.T.heroSizes.statementClosing,
      gapAfter: 2,
    });
  }, { estHeight: 250 });
  paymentBlock(R);
  // the notes sit below, behind a 0.5px rule, at 74% measure
  R.gap(12);
  R.rule(R.margin, R.y, R.margin + R.width * 0.74, 0.5, R.T.hairline);
  R.gap(8);
  for (const n of [WORDING.neverInvoiced, ...(d.noteLines || [])].filter(Boolean)) {
    R.ensure(30);
    R.text(n, { size: TYPE.fine, color: R.T.mid, lineGap: 3, width: R.width * 0.74 });
    R.gap(5);
  }
}

// ═══ 5. PAYMENT RECEIPT ══════════════════════════════════════════════════════
async function renderReceipt(R, d) {
  R.L.titleBlock(R, d.titleMeta);
  R.gap(14);
  R.ensure(170);
  {
    // nothing enclosed, no fill, no divider: the amount at the hero size IS
    // the emphasis — carried by the LANGUAGE'S emphasisBlock rule above
    // (Panel/Ledger 3px, Classic ink 0.75, Stationery accent 0.75), the
    // same recipe every hero figure now goes through. 0.75 ink closes below.
    const x = R.margin, w = R.width;
    R.emphasisBlock((bx, bw) => {
      R.gap(10);
      const y0 = R.y;
      const leftW = bw * 0.46;
      R.text("Amount received", { size: TYPE.fieldLabel, caps: true, tracking: 0.14, color: R.T.ink, x: bx, y: y0, width: leftW, advance: false });
      R.text(money(d.amount), { font: "Times-Roman", size: R.T.heroSizes.receipt, x: bx, y: y0 + 14, width: leftW, advance: false });
      R.text(amountInWords(d.amount), { size: 11.5, color: R.T.mid, x: bx, y: y0 + 14 + R.T.heroSizes.receipt + 6, width: leftW - 12, lineGap: 3, advance: false });
      const fx = bx + leftW + 20;
      const fw = bw - leftW - 20;
      let fy = y0;
      const fact = (label, value) => {
        if (!value) return;
        R.text(label, { size: 12, color: R.T.mid, x: fx, y: fy, width: fw * 0.4, advance: false });
        const h = R.text(value, { size: 12, x: fx + fw * 0.4, y: fy, width: fw * 0.6, align: "right", advance: false });
        fy += Math.max(h, 13) + 6;
      };
      fact("Received on", dateProse(d.receivedOn));
      fact("Mode", d.mode);
      fact("Bank reference", d.reference);
      fact("From", d.from);
      fact("Credited to", d.creditedTo);
      R.y = Math.max(y0 + 14 + R.T.heroSizes.receipt + 34, fy) + 4;
    }, { x, width: w, estHeight: 160 });
    R.rule(x, R.y, x + w, 0.75, R.T.ink);
    R.gap(2);
  }
  R.sectionLabel("What this payment was towards");
  const columns = [
    { key: "applied", label: "Applied to", width: 0.46 },
    { key: "reference", label: "Reference", width: 0.18 },
    { key: "amount", label: "Applied", width: 0.18, numeric: true },
    { key: "left", label: "Left on it", width: 0.18, numeric: true },
  ];
  const rows = d.applied.map((a, i) => ({
    cells: {
      applied: { text: a.label, subLine: a.subLine },
      reference: { text: a.reference || DASH, color: R.T.mid },
      amount: money(a.amount).replace("Rs. ", ""),
      left: a.left === 0 ? { text: "Settled", color: R.T.mid, size: TYPE.subLine + 0.5 } : money(a.left).replace("Rs. ", ""),
    },
    lastData: i === d.applied.length - 1,
  }));
  rows.push({
    kind: "total",
    cells: {
      applied: { text: "Total applied", bold: true },
      amount: { text: money(d.amount).replace("Rs. ", ""), bold: true },
    },
  });
  R.table({ columns, rows });
  // where the booking stands + the not-an-invoice note
  R.gap(SPACE.block);
  R.ensure(220);
  const y0 = R.y;
  const rightW = R.width * 0.40;
  const leftW = R.width - rightW - 18;
  R.text("Where the booking stands", { font: "Times-Italic", size: TYPE.sectionLabel, width: leftW });
  R.gap(10);
  const line = (label, value, opts = {}) => kvRow(R, { x: R.margin, width: leftW, label, value, ...opts });
  line(WORDING.totalPayable, money(d.totals.payable), { mid: false });
  if (d.totals.refundable) { R.text(WORDING.refundableHeld(d.totals.refundable), { size: TYPE.subLine, color: R.T.mid, width: leftW }); R.gap(7); }
  line("GST at 18%", money(d.totals.gst + d.totals.extrasGst), { mid: true });
  line("Collectable", money(d.totals.collectable), { mid: true });
  line("Received to date", `- ${money(d.received)}`, { mid: true });
  R.gap(3);
  line("Outstanding", money(d.outstanding), { figure: true });
  if (d.nextDue) { R.gap(6); R.text(d.nextDue, { size: TYPE.fine, color: R.T.mid, width: leftW, lineGap: 3 }); }
  const leftBottom = R.y;
  R.y = y0;
  {
    const nx = R.margin + R.width - rightW;
    R.rule(nx, R.y, nx + rightW, 0.5, R.T.hairline);
    R.gap(9);
    R.text("A receipt, not a tax invoice", { font: "Times-Italic", size: 13, x: nx, width: rightW, advance: false });
    R.gap(20);
    R.text("This document records money received. Tax invoices are raised per instalment with GST on its taxable share.", { size: TYPE.fine, color: R.T.mid, lineGap: 3, x: nx, width: rightW });
    R.gap(6);
    R.text(WORDING.neverInvoiced, { size: TYPE.fine, color: R.T.mid, lineGap: 3, x: nx, width: rightW });
  }
  R.y = Math.max(R.y, leftBottom);
  closingRow(R, d.noteLines || [], d.signatory);
}

const RENDERERS = {
  quote: renderQuote,
  confirmation: renderConfirmation,
  invoice: renderInvoice,
  statement: renderStatement,
  receipt: renderReceipt,
};

module.exports = { RENDERERS };

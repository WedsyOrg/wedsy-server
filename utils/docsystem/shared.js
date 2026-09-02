/**
 * utils/docsystem/shared.js — everything NO language may touch.
 *
 * LANGUAGES.md §1: the money arithmetic, the fixed wording, the table column
 * contracts, number and date format, type roles and the spacing rhythm are
 * the same code path for every venue. A language owns twelve values and seven
 * recipes (see languages/); nothing here reads a language.
 *
 * ── THE RUPEE (ruling 1) ────────────────────────────────────────────────────
 * U+20B9 exists in neither Helvetica nor Times as pdfkit ships them. Every
 * existing generator in this repo already writes "Rs." (venueStatementPdf,
 * venueInvoicePdf, venueBookingConfirmationPdf all carry the same money()
 * with the same comment). Consistency beats preference: this module is now
 * the ONE money formatter and it writes "Rs." — a venue gets the same mark
 * on every document it has ever sent. The fixed-wording sentences carry the
 * same substitution for the same reason.
 */

// ── THE UNIT ────────────────────────────────────────────────────────────────
// The handoff speaks CSS px (A4 previews at 96dpi: 794 × 1123). pdfkit speaks
// pt (A4 = 595 × 842). Rather than scattering ×0.75 conversions through every
// size, pad and rule, the ENGINE scales each page by 0.75 and everything in
// this system draws in the design's own px — 1:1 with the .dc.html files.
const A4 = { w: 595.28 / 0.75, h: 841.89 / 0.75 };
const MM = 96 / 25.4;
const PAGE_SCALE = 0.75;

/** "Rs. 13,32,500" — Indian grouping, no decimals unless paise exist. */
function money(n) {
  const v = Number(n) || 0;
  const negative = v < 0;
  const abs = Math.abs(v);
  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const s = hasPaise
    ? abs.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(abs).toLocaleString("en-IN");
  // ASCII hyphen-minus: U+2212 is outside WinAnsi and prints as a stray
  // quotation mark (caught on the live receipt's received-to-date line)
  return `${negative ? "- " : ""}Rs. ${s}`;
}

/** A non-applicable money cell is an em dash in mid — never blank, never 0. */
const DASH = "—";
const moneyOrDash = (n) => (n === null || n === undefined ? DASH : money(n));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "21 November 2026" — prose. */
function dateProse(d) {
  if (!d) return DASH;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return DASH;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}
/** "21 Nov 2026" — table cells. */
function dateCell(d) {
  if (!d) return DASH;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return DASH;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`;
}
/** "Sat 21 November 2026, 06:00" — the fact strip. */
function dateTimeProse(d) {
  if (!d) return DASH;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return DASH;
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}, ${hh}:${mm}`;
}

/** Indian-system amount in words: "Rupees Ten Lakh Forty-Three Thousand Six Hundred Only". */
function amountInWords(n) {
  const num = Math.round(Math.abs(Number(n) || 0));
  if (num === 0) return "Rupees Zero Only";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? `-${ones[x % 10]}` : ""}`);
  const three = (x) => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    return `${h ? `${ones[h]} Hundred${r ? " " : ""}` : ""}${r ? two(r) : ""}`;
  };
  const parts = [];
  const crore = Math.floor(num / 1e7);
  const lakh = Math.floor((num % 1e7) / 1e5);
  const thousand = Math.floor((num % 1e5) / 1e3);
  const rest = num % 1e3;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return `Rupees ${parts.join(" ")} Only`;
}

// ── FIXED WORDING — contractual, never reworded, never re-cased ─────────────
const WORDING = {
  totalPayable: "Total payable",
  refundableHeld: (amt) => `of which refundable, held ${DASH} returned after the event: ${money(amt)}`,
  gstSentence: (taxable, gst, of = "the quoted lines", pct = 18) =>
    `GST at ${pct}% applies to the taxable ${money(taxable)} of ${of} ${DASH} ${money(gst)} in all`,
  neverInvoiced: "The refundable deposit is held, not billed: it is never part of a tax invoice and is returned after the event.",
  extrasCaption: `Additional to the agreed amount ${DASH} they do not change it`,
  refundableTag: "REFUNDABLE",
  sumsExactly: "Sums exactly to total payable",
  chargedSubtotal: `Charged ${DASH} the venue's revenue`,
  poweredBy: "Powered by Wedsy",
};

// ── SHARED TYPE ROLES (a language may not shrink data) ──────────────────────
const TYPE = {
  body: 13.5,
  cell: 12.5,
  denseCell: 11.5,
  subLine: 10,
  fine: 11,
  columnHead: 8.5, // Classic; language columnHeadStyle may restyle size/tracking within its recipe
  fieldLabel: 8.5,
  reference: 10.5,
  footer: 9.5,
  platformMark: 8,
  sectionLabel: 14,
  totalLabel: 17,
  headlineFigure: 28,
};

// ── SPACING RHYTHM (shared; only pageMargin varies) ─────────────────────────
const SPACE = { labelToValue: 3, cellPad: 6, panelPad: 12, block: 22, section: 26, signature: 34, footerClearance: 22 };

// ── GST / MONEY ARITHMETIC ──────────────────────────────────────────────────
// NOT re-derived here. Every figure comes from utils/venueMoney — the same
// computeLineTotals/lineTaxable/lineGst the model, the guards and the Money
// tab already share. This module only SHAPES those figures for print.
const { computeLineTotals, lineTaxable, lineGst } = require("../venueMoney");

/** ONE line, shaped for print. Figures via venueMoney; nothing recomputed. */
function lineFigures(line, pct = 18) {
  const amount = Math.round(Number(line.amount) || 0);
  const refundable = Boolean(line.refundable);
  const taxable = lineTaxable(line);
  const gst = lineGst(line, pct);
  const treatment = refundable ? "none" : (line.gstTreatment || "none");
  return { label: line.label, amount, taxable, gst, lineTotal: amount + gst, refundable, treatment };
}

/**
 * The three figures and their meanings (fixed, LANGUAGES.md §1): charged =
 * revenue ex-deposit; payable = charged + extras + refundable held;
 * collectable = payable + GST. Line figures from venueMoney; extras are
 * schedule rows, which the model carries WITHOUT a GST treatment today —
 * they contribute no invented tax unless a caller hands lines that carry one.
 */
function documentTotals(lines, extras = [], pct = 18) {
  const lf = computeLineTotals(lines, pct);
  const ef = computeLineTotals(extras, pct);
  return {
    pct,
    charged: lf.charged, taxable: lf.taxable, gst: lf.gst, refundable: lf.refundable,
    extrasAmount: ef.charged + ef.refundable, extrasGst: ef.gst,
    payable: lf.charged + lf.refundable + ef.charged + ef.refundable,
    collectable: lf.charged + lf.refundable + ef.charged + ef.refundable + lf.gst + ef.gst,
  };
}

/**
 * Schedule GST allocation for line bookings: the total GST spread pro-rata
 * over each row's NON-refundable share, rounded per row with the LAST row
 * absorbing the remainder — so the printed columns sum EXACTLY (the
 * "Sums exactly to total payable" row is proven, not decorative). The
 * refundable held is attributed from the FINAL instalment backwards, since
 * the schedule carries it but no row is taxed on it.
 */
function allocateScheduleGst(rows, totals) {
  const out = rows.map((r) => ({ ...r, payable: Math.round(Number(r.amount) || 0) }));
  let refundableLeft = totals.refundable;
  for (let i = out.length - 1; i >= 0; i--) {
    const carried = Math.min(refundableLeft, out[i].payable);
    out[i].refundableCarried = carried;
    refundableLeft -= carried;
  }
  const exRefundable = out.map((r) => r.payable - r.refundableCarried);
  const base = exRefundable.reduce((s, v) => s + v, 0);
  const totalGst = totals.gst + totals.extrasGst;
  let assigned = 0;
  out.forEach((r, i) => {
    r.gst = i === out.length - 1
      ? totalGst - assigned
      : base > 0 ? Math.round(totalGst * (exRefundable[i] / base)) : 0;
    assigned += i === out.length - 1 ? 0 : r.gst;
    r.collectable = r.payable + r.gst;
  });
  return out;
}

module.exports = {
  A4, MM, DASH, PAGE_SCALE,
  money, moneyOrDash, dateProse, dateCell, dateTimeProse, amountInWords,
  WORDING, TYPE, SPACE,
  lineFigures, documentTotals, allocateScheduleGst,
};

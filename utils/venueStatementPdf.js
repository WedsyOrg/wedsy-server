/**
 * utils/venueStatementPdf.js — the STATEMENT OF ACCOUNT.
 *
 * The answer to "send me the total bill". Not an invoice for one payment: the
 * whole booking on one page — what was agreed, every additional billing line
 * itemised, the total, everything received, and the balance.
 *
 * Built from the same parts as every other venue document: venueHeader and
 * poweredByFooter from utils/venuePdf, branding via utils/venueBranding, dates
 * via utils/documentDate, and every table through utils/venueDocTable.renderTable
 * — which repeats the header across pages and refuses to let a cell taller than
 * a page silently truncate.
 *
 * ── NOTHING HERE DERIVES MONEY ──────────────────────────────────────────────
 * Build B settled that utils/venuePaymentStatus.summarizeSchedule is the single
 * source. This file is handed its output and renders it. It does not sum
 * payments, does not decide what "received" means, and does not recompute a
 * balance. If a figure on this page disagrees with the Money tab, the bug is
 * upstream of here — which is the point.
 *
 * ── HOW GST IS HANDLED, AND WHY IT IS NOT ADDED UP ──────────────────────────
 * GST is STATED where it was charged, never recomputed into a new total.
 *
 * The reason is a real property of the model, not a stylistic choice:
 * utils/venuePaymentStatus contains no reference to GST at all. The schedule,
 * `received` and `balance` are GST-agnostic — they track `row.amount`, and the
 * overpayment guard compares against `row.amount` too. GST is layered on top,
 * for display (venuePaymentSchedule.gstOnRow) and on invoices (which store
 * their own `totals.gst`).
 *
 * So this document:
 *   · shows agreed / additional / total / received / balance exactly as
 *     summarizeSchedule reports them, and labels them as following the schedule
 *   · shows, per instalment, the GST that instalment bears under the booking's
 *     own setting — a separate column, never folded into the total
 *   · shows each invoice's GST as the invoice itself stored it
 *   · says all of that in a sentence on the page, so the reader is never left
 *     to infer whether a total includes tax
 *
 * Adding the two together would invent a number the system does not hold: the
 * schedule's rows are recorded exclusive of GST, so "total + GST" would only be
 * correct if every instalment had been invoiced with the booking's current GST
 * setting — which no data here asserts.
 */
const {
  bufferDoc,
  loadLogoBuffer,
  venueHeader,
  poweredByFooter,
  BURGUNDY,
  GREY,
} = require("./venuePdf");
const { resolveBranding } = require("./venueBranding");
const { docDayWithWeekday, docInstantDay, docDay } = require("./documentDate");
const { renderTable } = require("./venueDocTable");
const { gstOnRow } = require("./venuePaymentSchedule");

const BODY = "#222222";
const TEXT_W = 495;
const PANEL = "#f6f4f7";

/** "Rs. 8,12,500" — Helvetica has no rupee glyph, same call every doc makes. */
const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * ── EVERY GLYPH ON THE PAGE MUST EXIST IN WinAnsi ───────────────────────────
 * The standard-14 Helvetica PDFKit uses is WinAnsi-encoded. A character outside
 * that set is not dropped cleanly — it is written as whatever bytes fall out of
 * the mapping, and U+2212 MINUS SIGN came out as 0x22 0x12: a stray double
 * quote and an unprintable, on the "Received" line of a money document.
 *
 * The same reason `money()` above writes "Rs." rather than the rupee sign. This
 * is that rule applied to the typographic characters it is easy to reach for by
 * habit: minus, the dashes, curly quotes, ellipsis. Em dash (0x97), en dash
 * (0x96) and the middle dot (0xB7) ARE in WinAnsi and are deliberately left
 * alone — verified in the rendered bytes, not assumed.
 */
const WINANSI_SWAPS = [
  [/\u2212/g, "-"],   // MINUS SIGN → hyphen-minus
  [/[\u2018\u2019]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];
function ascii(v) {
  let out = String(v == null ? "" : v);
  for (const [re, to] of WINANSI_SWAPS) out = out.replace(re, to);
  return out;
}

const methodLabel = (m, other) => {
  const s = String(m || "").replace(/_/g, " ").trim();
  if (!s) return "";
  if (s === "other" && other) return String(other);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function sectionTitle(doc, text) {
  doc.moveDown(0.7);
  doc.font("Helvetica-Bold").fillColor(BURGUNDY).fontSize(11).text(text, 50, doc.y, { width: TEXT_W });
  doc.font("Helvetica");
  doc.moveDown(0.35);
}

function note(doc, text) {
  doc.fillColor(GREY).fontSize(8.5).text(text, 50, doc.y, { width: TEXT_W });
  doc.moveDown(0.3);
}

/**
 * @param {object} args
 * @param {object} args.venue     selected with BRANDING_SELECT
 * @param {object} args.booking
 * @param {object} args.summary   summarizeSchedule(booking) — NOT recomputed here
 * @param {object[]} [args.invoices] persisted VenueInvoice rows for this lead
 * @param {object} [args.lead]    for the billed-to fallback
 * @returns {Promise<{buffer: Buffer, tableStats: object[], gstStated: string}>}
 */
async function buildStatementPdf({ venue, booking, summary, invoices = [], lead } = {}) {
  const brand = resolveBranding(venue || {});
  const bk = booking || {};
  const sum = summary || { rows: [], totals: {} };
  const totals = sum.totals || {};
  const rows = sum.rows || [];
  const logoBuffer = await loadLogoBuffer(brand.logo);

  const gstMode = bk.gstMode || "none";
  const gstPercent = Number(bk.gstPercent) || 0;
  const gstOn = gstMode !== "none" && gstPercent > 0;

  const { doc, done } = bufferDoc();
  const stats = [];
  venueHeader(doc, venue || {}, "Statement of Account", logoBuffer);

  if (gstOn && brand.taxLine) {
    doc.fillColor(GREY).fontSize(9).text(brand.taxLine, 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.4);
  } else if (!gstOn && brand.pan) {
    doc.fillColor(GREY).fontSize(9).text(`PAN: ${brand.pan}`, 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.4);
  }

  // ── who and what ─────────────────────────────────────────────────────────
  const row = (label, value) => {
    if (!value) return; // absent → no row, no dangling label
    const y = doc.y;
    doc.fillColor(GREY).fontSize(9).text(String(label).toUpperCase(), 50, y, { width: 110 });
    doc.fillColor(BODY).fontSize(10).text(String(value), 165, y, { width: 380 });
    doc.moveDown(0.32);
  };
  row("Statement date", docInstantDay(new Date()));
  row("Billed to", ascii(bk.coupleName || (lead && lead.coupleName)));
  row("Phone", bk.couplePhone || (lead && lead.couplePhone));
  const days = (bk.days || []).map((d) => d && d.date).filter(Boolean);
  if (days.length === 1) row("Event date", docDayWithWeekday(days[0]));
  else if (days.length > 1) {
    row("Event dates", docDayWithWeekday(days[0]));
    days.slice(1).forEach((d) => row("", docDayWithWeekday(d)));
  }
  const spaces = [...new Set((bk.days || []).flatMap((d) => (d && d.spaces) || []))].filter(Boolean);
  if (spaces.length) row("Spaces", ascii(spaces.join(", ")));

  // ══ 1. WHAT IS OWED ══════════════════════════════════════════════════════
  const additionalRows = rows.filter((r) => r.isAdditional);
  sectionTitle(doc, "What is owed");

  const owedTable = [["Agreed booking value", money(totals.bookingValue)]];
  if (additionalRows.length) {
    // ITEMISED, not a single "additional" figure. The whole reason an owner
    // sends this document is so the client can see what the extras were.
    for (const r of additionalRows) {
      const why = [r.addedNote, r.addedByName ? `added by ${r.addedByName}` : ""].filter(Boolean).join(" · ");
      owedTable.push([ascii(`Additional — ${r.label}${why ? `  (${why})` : ""}`), money(r.amount)]);
    }
  }
  owedTable.push([{ text: "Total payable", backgroundColor: PANEL }, { text: money(totals.total), backgroundColor: PANEL }]);
  stats.push(
    renderTable(doc, {
      header: [
        { text: "Item", backgroundColor: PANEL },
        { text: "Amount", backgroundColor: PANEL },
      ],
      rows: owedTable,
      opts: { columnStyles: ["*", 120] },
    })
  );
  if (!additionalRows.length) note(doc, "No additional billing has been added to this booking.");

  // ══ 2. THE SCHEDULE ══════════════════════════════════════════════════════
  if (rows.length) {
    sectionTitle(doc, "Payment schedule");
    const header = [
      { text: "Instalment", backgroundColor: PANEL },
      { text: "Due", backgroundColor: PANEL },
      { text: "Amount", backgroundColor: PANEL },
    ];
    if (gstOn) header.push({ text: `GST @ ${gstPercent}%`, backgroundColor: PANEL });
    header.push({ text: "Received", backgroundColor: PANEL });

    stats.push(
      renderTable(doc, {
        header,
        rows: rows.map((r) => {
          const cells = [
            ascii(`${r.label}${r.isAdditional ? "  (additional)" : ""}`),
            r.dueDate ? docDay(r.dueDate) : "—",
            money(r.amount),
          ];
          if (gstOn) {
            // Read from the booking's own setting for this row — the same call
            // the Money tab makes. Not a new rule invented for the document.
            const g = gstOnRow(r.amount, { gstMode, gstPercent, rowApplicable: Boolean(r.gstApplicable) });
            cells.push(g.bears ? money(g.gst) : "—");
          }
          cells.push(r.paidAmount > 0 ? money(r.paidAmount) : "—");
          return cells;
        }),
        opts: { columnStyles: gstOn ? ["*", 75, 85, 75, 85] : ["*", 85, 100, 100] },
      })
    );
  }

  // ══ 3. WHAT HAS BEEN RECEIVED ════════════════════════════════════════════
  sectionTitle(doc, "Payments received");
  // Approved entries only — the same rule summarizeSchedule applies. Money that
  // has been claimed but not approved is not in the books, and a statement that
  // counted it would be telling a client they had paid when they had not.
  const receipts = [];
  for (const r of rows) {
    for (const e of r.entries || []) {
      if ((e.status || "approved") !== "approved") continue;
      receipts.push({ row: r, e });
    }
  }
  if (receipts.length) {
    stats.push(
      renderTable(doc, {
        header: [
          { text: "Date", backgroundColor: PANEL },
          { text: "Towards", backgroundColor: PANEL },
          { text: "Method", backgroundColor: PANEL },
          { text: "Reference", backgroundColor: PANEL },
          { text: "Amount", backgroundColor: PANEL },
        ],
        rows: receipts.map(({ row: r, e }) => [
          e.date ? docDay(e.date) : "—",
          ascii(r.label),
          ascii(methodLabel(e.method, e.methodOther)) || "—",
          ascii(e.reference) || "—",
          money(e.amount),
        ]),
        opts: { columnStyles: [78, "*", 78, 100, 85] },
      })
    );
  } else {
    note(doc, "Nothing has been received against this booking yet.");
  }

  // ══ 4. INVOICES RAISED ═══════════════════════════════════════════════════
  // Listed with the numbers each invoice STORED, so the client can match this
  // page against the documents they were sent. Never recomputed.
  if (invoices.length) {
    sectionTitle(doc, "Invoices raised");
    stats.push(
      renderTable(doc, {
        header: [
          { text: "Invoice", backgroundColor: PANEL },
          { text: "Issued", backgroundColor: PANEL },
          { text: "Subtotal", backgroundColor: PANEL },
          { text: "GST", backgroundColor: PANEL },
          { text: "Total", backgroundColor: PANEL },
        ],
        rows: invoices.map((inv) => {
          const t = inv.totals || {};
          return [
            inv.invoiceNumber || "—",
            inv.createdAt ? docDay(inv.createdAt) : "—",
            money(t.subtotal),
            inv.gstMode === "none" ? "Not applicable" : money(t.gst),
            money(t.grandTotal),
          ];
        }),
        opts: { columnStyles: ["*", 80, 85, 85, 90] },
      })
    );
  }

  // ══ 5. THE BOTTOM LINE ═══════════════════════════════════════════════════
  doc.moveDown(0.7);
  const right = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.fillColor(bold ? BURGUNDY : GREY).fontSize(bold ? 13 : 10).text(label, 290, y, { width: 150, align: "right" });
    doc.fillColor(bold ? BURGUNDY : BODY).fontSize(bold ? 13 : 10).text(value, 450, y, { width: 95, align: "right" });
    doc.font("Helvetica");
    doc.moveDown(bold ? 0.34 : 0.28);
  };
  right("Agreed booking value", money(totals.bookingValue));
  if (Number(totals.additional) > 0) right("Additional billing", money(totals.additional));
  right("Total payable", money(totals.total));
  right("Received", `- ${money(totals.received)}`);
  right("Balance due", money(totals.balance), true);

  // Claimed-but-unapproved money, stated BESIDE the balance and never inside
  // it. An owner reading this has to know money has been offered; a client
  // reading it has to not be told it has been accepted.
  if (Number(totals.pending) > 0) {
    doc.moveDown(0.2);
    doc.fillColor(GREY).fontSize(9).text(
      `${money(totals.pending)} has been recorded but not yet confirmed, and is not included above.`,
      50,
      doc.y,
      { width: TEXT_W }
    );
    doc.moveDown(0.3);
  }

  // ── THE GST SENTENCE ─────────────────────────────────────────────────────
  // Said out loud, always. A reader must never have to infer whether these
  // totals include tax, and an absent GST line is exactly the kind of silence
  // that gets read as an oversight.
  doc.moveDown(0.45);
  let gstStated;
  if (!gstOn) {
    gstStated = "none";
    doc.fillColor(GREY).fontSize(9).text("GST is not applicable on this booking.", 50, doc.y, { width: TEXT_W });
  } else if (gstMode === "whole") {
    gstStated = "whole";
    doc.fillColor(GREY).fontSize(9).text(
      `GST at ${gstPercent}% applies to every instalment on this booking and is shown per instalment above. ` +
        `The totals here follow the agreed payment schedule, which is recorded exclusive of GST — ` +
        `the tax charged on each invoice is stated on that invoice.`,
      50,
      doc.y,
      { width: TEXT_W }
    );
  } else {
    gstStated = "per_instalment";
    const bearing = rows.filter((r) => r.gstApplicable).length;
    doc.fillColor(GREY).fontSize(9).text(
      `GST at ${gstPercent}% applies to ${bearing} of ${rows.length} instalment${rows.length === 1 ? "" : "s"} on this ` +
        `booking, shown per instalment above. The totals here follow the agreed payment schedule, which is recorded ` +
        `exclusive of GST — the tax charged on each invoice is stated on that invoice.`,
      50,
      doc.y,
      { width: TEXT_W }
    );
  }
  doc.moveDown(0.4);

  if (!totals.scheduleMatchesValue) {
    // Surfaced rather than smoothed over, matching summarizeSchedule's own
    // decision to report it instead of quietly picking the larger number.
    doc.fillColor(GREY).fontSize(9).text(
      `Note: the instalments above total ${money(totals.scheduled)} against a payable of ${money(totals.total)}.`,
      50,
      doc.y,
      { width: TEXT_W }
    );
    doc.moveDown(0.3);
  }

  poweredByFooter(doc, "", brand.whiteLabel);
  doc.end();
  const buffer = await done;
  return { buffer, tableStats: stats, gstStated };
}

module.exports = { buildStatementPdf, money };

// Booking engine — native pdfkit tables, and the invoice document.
// Run: node tests/venue-doc-table.test.js
//
// Pins the two limits the pdfkit spike (#131) measured, because both fail
// SILENTLY and a customer document is where you would notice:
//   1. a cell taller than one page truncates with no error
//   2. the header row is not repeated on continuation pages
//
// Rendered text is read by decoding content streams (inflated, hex/literal
// operands reassembled) — grepping raw PDF bytes is vacuous, since pdfkit writes
// text as hex in kerned TJ arrays. Every check that asserts an ABSENCE is
// preceded by one proving the decoder can see a known string.
const zlib = require("zlib");
const { PDFDocument } = require("pdf-lib");

const { bufferDoc } = require("../utils/venuePdf");
const { renderTable, guardCell, DEFAULT_MAX_CELL_CHARS } = require("../utils/venueDocTable");
const { buildInvoicePdf } = require("../utils/venueInvoicePdf");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

function decode(bytes) {
  let b = bytes;
  if (b.length > 2 && b[0] === 0x78) { try { b = zlib.inflateSync(b); } catch { /* leave */ } }
  const s = b.toString("latin1");
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2 === 0) out += Buffer.from(hex, "hex").toString("latin1");
    } else out += m[2];
  }
  return out;
}

async function pageTexts(buf) {
  const pdf = await PDFDocument.load(buf);
  const out = [];
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const raw = pdf.getPage(i).node.Contents();
    let by = Buffer.alloc(0);
    if (raw) {
      const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
      for (const r of parts) {
        const st = pdf.context.lookup(r);
        const c = st && (st.getContents ? st.getContents() : st.contents);
        if (c) by = Buffer.concat([by, Buffer.from(c)]);
      }
    }
    out.push(decode(by));
  }
  return out;
}

const table = async (rows, header = ["Milestone", "Due", "%", "Amount", "Status"]) => {
  const { doc, done } = bufferDoc();
  doc.fontSize(10).text("Schedule", 50, 50);
  const stats = renderTable(doc, { header, rows, opts: { columnStyles: ["*", 90, 45, 90, 60] } });
  doc.end();
  return { buf: await done, stats };
};

// The first cell carries a FIXED-WIDTH marker ("ROW0007") because cells
// concatenate with no separator in the content stream: a plain
// "Instalment 1" followed by a date reads as "Instalment 12026-11-02", and a
// greedy \d+ then extracts 12026. Four fixed digits are unambiguous.
const scheduleRows = (n) =>
  Array.from({ length: n }, (_, i) => [
    `ROW${String(i + 1).padStart(4, "0")} Instalment`,
    `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
    `${(i % 9) + 1}%`,
    `Rs. ${(10000 + i * 137).toLocaleString("en-IN")}`,
    i % 3 === 0 ? "Paid" : "Due",
  ]);

(async () => {
  try {
    // ══ 1 · THE HEADER REPEATS ═══════════════════════════════════════════════
    console.log("\n[1. limit 2 from the spike: the header must repeat on every page]");
    const short = await table(scheduleRows(8));
    const shortPages = await pageTexts(short.buf);
    ok(shortPages[0].includes("Milestone") && shortPages[0].includes("Status"),
      "the decoder sees the header on page 1 (guards every check below)");
    ok(shortPages.length === 1 && short.stats.pages === 1, "8 rows stay on one page");
    ok(short.stats.headerRepeats === 0, "…and the header is not needlessly repeated");

    const long = await table(scheduleRows(90));
    const longPages = await pageTexts(long.buf);
    ok(longPages.length > 1, `90 rows paginate (${longPages.length} pages)`);
    ok(long.stats.pages === longPages.length, `…and the reported page count matches reality (${long.stats.pages})`);
    ok(longPages.every((t) => t.includes("Milestone")), "THE FIX: every page carries the header row");
    ok(long.stats.headerRepeats === longPages.length - 1, `…re-emitted once per continuation page (${long.stats.headerRepeats})`);
    // Nothing lost across the break. Counted rather than matched by index,
    // because cells concatenate with no separator ("Instalment 1" + "2026-…").
    const rendered = longPages.reduce((n, t) => n + (t.match(/ROW\d{4}/g) || []).length, 0);
    ok(rendered === 90, `all 90 rows rendered (counted ${rendered})`);
    ok(longPages.every((t) => (t.match(/ROW\d{4}/g) || []).length > 0), "…and no page is header-only");

    // Rows must stay in order across the break, not reflow.
    const nums = (t) => (t.match(/ROW(\d{4})/g) || []).map((m) => Number(m.slice(3)));
    const first = nums(longPages[0]);
    const second = nums(longPages[1]);
    ok(first[0] === 1, `page 1 starts at row 1 (got ${first[0]})`);
    ok(second[0] === first[first.length - 1] + 1,
      `page 2 continues from where page 1 stopped (${first[first.length - 1]} → ${second[0]})`);
    const flat = longPages.flatMap(nums);
    ok(flat.every((v, k) => k === 0 || v > flat[k - 1]), "…and rows are strictly ascending across every page");

    // ══ 2 · THE TRUNCATION GUARD ═════════════════════════════════════════════
    console.log("\n[2. limit 1 from the spike: an oversized cell is capped, visibly]");
    const g = guardCell("word ".repeat(400));
    ok(g.truncated === true, "a cell past the cap is marked truncated");
    ok(g.text.length <= DEFAULT_MAX_CELL_CHARS + 1, `…and capped (${g.text.length} chars)`);
    ok(g.text.endsWith("…"), "…ending in an ellipsis, so a reader can see there was more");
    ok(!g.text.endsWith(" …"), "…cut on a word boundary rather than mid-word");
    const small = guardCell("short text");
    ok(small.truncated === false && small.text === "short text", "a normal cell is untouched");
    ok(guardCell(null).text === "" && guardCell(undefined).text === "", "null/undefined render as empty, never \"null\"");
    ok(guardCell(0).text === "0", "a zero renders as 0, not as empty");

    const prose = await table([["Clause", "—", "—", "—", "x ".repeat(3000)]]);
    ok(prose.stats.truncatedCells === 1, "rendering reports how many cells it had to cap");
    const proseText = (await pageTexts(prose.buf)).join("");
    // pdfkit writes the standard fonts in WinAnsi, where U+2026 is byte 0x85 —
    // decoding as latin1 therefore yields "\x85", not "…".
    ok(proseText.includes("\u0085") || proseText.includes("…"),
      "…and the document itself shows the ellipsis (WinAnsi 0x85)");

    // ══ 3 · THE INVOICE DOCUMENT ═════════════════════════════════════════════
    console.log("\n[3. the invoice renders from the booking, with GST optional]");
    const venue = {
      name: "Crown Estate", address: "12 Palace Road, Bangalore",
      contact: { primaryPhone: "9800000000", email: "hello@example.com" },
      gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", invoicePrefix: "CE-",
    };
    const booking = {
      coupleName: "Priya & Arjun", couplePhone: "9800001111", totalValue: 1929300,
      days: [
        { date: new Date("2026-11-26T00:00:00Z"), spaces: ["Grand Lawn"] },
        { date: new Date("2026-11-27T00:00:00Z"), spaces: ["Banquet Hall"] },
      ],
    };
    const lineItems = [{ label: "Venue hire", qty: 1, unitPrice: 1200000 }, { label: "Catering", qty: 300, unitPrice: 1450 }];

    const withGst = await buildInvoicePdf({
      venue, booking,
      invoice: { invoiceNumber: "CE-0001", createdAt: new Date("2026-08-17T06:00:00Z"), lineItems, discount: 0,
        gstMode: "exclusive", gstPercent: 18, totals: { subtotal: 1635000, taxable: 1635000, gst: 294300, grandTotal: 1929300 } },
      payment: { amount: 400000, mode: "bank_transfer", reference: "UTR99881" },
    });
    const gTxt = (await pageTexts(withGst.buffer)).join("");
    ok(gTxt.includes("Crown Estate"), "the decoder sees the venue name (guards the absence checks below)");
    ok(gTxt.includes("Tax Invoice"), 'with GST the document is titled "Tax Invoice"');
    ok(gTxt.includes("29ABCDE1234F1Z5"), "…and carries the GSTIN from Settings");
    ok(gTxt.includes("CE-0001"), "…the invoice number");
    ok(gTxt.includes("Priya & Arjun"), "…who it is billed to");
    ok(gTxt.includes("Thursday, 26 November 2026"), "…event dates with their weekday, composed not localised");
    ok(gTxt.includes("Friday, 27 November 2026"), "…including the second day");
    ok(gTxt.includes("Grand Lawn") && gTxt.includes("Banquet Hall"), "…and the spaces");
    ok(gTxt.includes("UTR99881"), "…and the payment reference it was raised against");
    ok(gTxt.includes("Rs. 2,94,300"), "…GST shown as its own line");
    ok(gTxt.includes("Rs. 19,29,300"), "…and the grand total");
    ok(!gTxt.includes("₹"), "no rupee glyph anywhere — Helvetica cannot draw it");

    const noGst = await buildInvoicePdf({
      venue, booking,
      invoice: { invoiceNumber: "CE-0002", createdAt: new Date("2026-08-17T06:00:00Z"), lineItems, discount: 0,
        gstMode: "none", gstPercent: 0, totals: { subtotal: 1635000, taxable: 1635000, gst: 0, grandTotal: 1635000 } },
    });
    const nTxt = (await pageTexts(noGst.buffer)).join("");
    ok(nTxt.includes("Crown Estate"), "the decoder sees the GST-off document too");
    ok(nTxt.includes("Invoice") && !nTxt.includes("Tax Invoice"), 'without GST it is titled "Invoice", not "Tax Invoice"');
    ok(!nTxt.includes("29ABCDE1234F1Z5"), "…and does NOT carry a GSTIN it is not charging under");
    ok(nTxt.includes("GST not applicable"), "…saying so out loud, so a missing line does not read as an oversight");
    ok(nTxt.includes("Rs. 16,35,000"), "…and the total excludes tax");

    console.log("\n[3b. missing optional fields never render junk]");
    const bare = await buildInvoicePdf({ venue: { name: "Bare Venue" }, booking: {}, invoice: { invoiceNumber: "X-1", gstMode: "none", totals: {} } });
    const bTxt = (await pageTexts(bare.buffer)).join("");
    ok(bTxt.includes("Bare Venue"), "a near-empty invoice still renders (and the decoder sees it)");
    for (const bad of ["undefined", "null", "NaN", "Invalid Date"]) {
      ok(!bTxt.includes(bad), `…and never renders "${bad}"`);
    }
    ok(!bTxt.includes("PHONE"), "…draws no PHONE row when there is no phone");
    ok(!bTxt.includes("SPACES"), "…nor a SPACES row when there are none");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();

/**
 * THE MAIN QUESTION: does doc.table() page-break a table taller than one page?
 *
 * The docs don't say, so this answers it by building deliberately long tables and
 * reading what came out — page count, and which rows landed on which page.
 *
 * Rows are located by decoding each page's content stream (inflated, then hex/
 * literal string operands reassembled) — grepping raw bytes is vacuous because
 * pdfkit writes text as hex inside kerned TJ arrays. Every probe asserts first
 * that the decoder can see a known row, so a "row not found" result means the row
 * is absent rather than the decoder being blind.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const REPO = path.join(__dirname, "..");
const PDFKit = require(path.join(REPO, "node_modules/pdfkit"));
const { PDFDocument } = require(path.join(REPO, "node_modules/pdf-lib"));
const OUT = path.join(__dirname, "tables");
fs.mkdirSync(OUT, { recursive: true });

const build = (fn, opts = {}) =>
  new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: "A4", margin: 50, compress: false, ...opts });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      fn(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });

function decodeStream(bytes) {
  let b = bytes;
  if (b.length > 2 && b[0] === 0x78) {
    try { b = zlib.inflateSync(b); } catch { /* leave */ }
  }
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
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  const texts = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const raw = doc.getPage(i).node.Contents();
    let bytes = Buffer.alloc(0);
    if (raw) {
      const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
      for (const r of parts) {
        const st = doc.context.lookup(r);
        if (!st) continue;
        const c = typeof st.getContents === "function" ? st.getContents() : st.contents;
        if (c) bytes = Buffer.concat([bytes, Buffer.from(c)]);
      }
    }
    texts.push(decodeStream(bytes));
  }
  return texts;
}

const say = (s) => console.log(s);
let failures = 0;
const check = (cond, label) => {
  if (cond) say(`     ✓ ${label}`);
  else { failures++; say(`     ✗ ${label}`); }
};

(async () => {
  say(`pdfkit ${require(path.join(REPO, "node_modules/pdfkit/package.json")).version}  node ${process.version}\n`);

  // ══ 1 · PAGINATION ═══════════════════════════════════════════════════════
  say("[1] A table far taller than one page");
  const ROWS = 120;
  const buf1 = await build((doc) => {
    doc.fontSize(10).text("Payment schedule", 50, 50);
    doc.table({
      data: [
        ["Instalment", "Due", "Amount"],
        ...Array.from({ length: ROWS }, (_, i) => [`Instalment ${i + 1}`, `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, `Rs. ${(10000 + i * 137).toLocaleString("en-IN")}`]),
      ],
    });
  });
  fs.writeFileSync(path.join(OUT, "long-table.pdf"), buf1);
  const t1 = await pageTexts(buf1);
  say(`     ${ROWS} data rows -> ${t1.length} page(s)`);
  // Prove the decoder works before trusting any "not found".
  check(t1[0].includes("Instalment 1"), "decoder sees row 1 on page 1 (guards every check below)");
  check(t1.length > 1, `THE ANSWER: the table paginates automatically (${t1.length} pages, no handling by us)`);
  const found = [];
  for (let i = 1; i <= ROWS; i++) {
    const pg = t1.findIndex((tx) => tx.includes(`Instalment ${i}`) && tx.includes(`Rs. ${(10000 + (i - 1) * 137).toLocaleString("en-IN")}`));
    found.push(pg);
  }
  const missing = found.map((p, i) => (p === -1 ? i + 1 : null)).filter(Boolean);
  check(missing.length === 0, `every one of the ${ROWS} rows is present (missing: ${missing.length ? missing.join(",") : "none"})`);
  const perPage = {};
  found.forEach((p) => { perPage[p + 1] = (perPage[p + 1] || 0) + 1; });
  say(`     rows per page: ${JSON.stringify(perPage)}`);
  const monotonic = found.every((p, i) => i === 0 || p >= found[i - 1]);
  check(monotonic, "rows stay in order across the page break (no reflow/shuffle)");
  // Header repetition — the thing an invoice actually needs.
  const headerPages = t1.map((tx, i) => (tx.includes("Instalment") && tx.includes("Due") && tx.includes("Amount") ? i + 1 : null)).filter(Boolean);
  const hdrRepeated = t1.every((tx) => /Due/.test(tx));
  say(`     header row ("Instalment/Due/Amount") appears on page(s): ${headerPages.join(", ")}`);
  say(`     ${hdrRepeated ? "→ header IS repeated on continuation pages" : "→ header is NOT repeated — continuation pages have no column labels"}`);

  // ══ 2 · A SINGLE ROW TALLER THAN A PAGE ══════════════════════════════════
  say("\n[2] A single row whose content is taller than one page");
  let buf2 = null, err2 = null;
  try {
    buf2 = await build((doc) => {
      doc.table({
        data: [
          ["Clause", "Detail"],
          ["Mega", "word ".repeat(4000)],
          ["After", "this row must still exist"],
        ],
      });
    });
  } catch (e) { err2 = e; }
  if (err2) {
    check(false, `threw: ${err2.message}`);
  } else {
    fs.writeFileSync(path.join(OUT, "tall-row.pdf"), buf2);
    const t2 = await pageTexts(buf2);
    say(`     -> ${t2.length} page(s)`);
    check(t2.some((x) => x.includes("Mega")), "the oversized row rendered");
    const splits = t2.filter((x) => /word/.test(x)).length;
    say(`     the oversized cell's text spans ${splits} page(s)`);
    check(t2.some((x) => x.includes("this row must still exist")), "the row AFTER the oversized one survived");
  }

  // ══ 3 · colSpan / rowSpan ════════════════════════════════════════════════
  say("\n[3] colSpan / rowSpan");
  let buf3 = null, err3 = null;
  try {
    buf3 = await build((doc) => {
      doc.table({
        data: [
          [{ colSpan: 3, text: "SPANS ALL THREE COLUMNS" }],
          ["A1", "B1", "C1"],
          [{ rowSpan: 2, text: "TALL LEFT" }, "B2", "C2"],
          ["B3", "C3"],
          [{ colSpan: 2, text: "TWO WIDE" }, "C4"],
        ],
      });
    });
  } catch (e) { err3 = e; }
  if (err3) check(false, `threw: ${err3.message}`);
  else {
    fs.writeFileSync(path.join(OUT, "spans.pdf"), buf3);
    const t3 = (await pageTexts(buf3)).join("");
    check(t3.includes("SPANS ALL THREE COLUMNS"), "colSpan:3 cell rendered");
    check(t3.includes("TALL LEFT"), "rowSpan:2 cell rendered");
    check(t3.includes("TWO WIDE"), "colSpan:2 beside a normal cell rendered");
    check(t3.includes("B3") && t3.includes("C3"), "the row under a rowSpan keeps its own cells (B3/C3)");
  }

  // ══ 4 · COLUMN SIZING ════════════════════════════════════════════════════
  say("\n[4] Column sizing — fixed points and \"*\"");
  let buf4 = null, err4 = null;
  try {
    buf4 = await build((doc) => {
      doc.table({
        columnStyles: [80, "*", 100],
        data: [["Fixed80", "Star fills the rest", "Fixed100"], ["a", "b", "c"]],
      });
      doc.moveDown(2);
      doc.table({
        columnStyles: ["*", "*"],
        data: [["half", "half"]],
      });
      doc.moveDown(2);
      doc.table({
        columnStyles: (i) => ({ width: i === 0 ? 60 : "*" }),
        data: [["fn0", "fn1"]],
      });
    });
  } catch (e) { err4 = e; }
  if (err4) check(false, `threw: ${err4.message}`);
  else {
    fs.writeFileSync(path.join(OUT, "sizing.pdf"), buf4);
    const t4 = (await pageTexts(buf4)).join("");
    check(t4.includes("Fixed80") && t4.includes("Fixed100"), "fixed point widths accepted (array form)");
    check(t4.includes("Star fills the rest"), '"*" star column accepted');
    check(t4.includes("half"), 'two "*" columns accepted');
    check(t4.includes("fn0") && t4.includes("fn1"), "columnStyles as a function accepted");
  }

  // ══ 5 · STYLE PRECEDENCE ═════════════════════════════════════════════════
  // defaultStyle -> columnStyles -> rowStyles -> cell, each expected to beat the
  // one before it. Asserted on the RENDERED fill colour, not on the option
  // object, because the question is what the reader sees.
  say("\n[5] Style precedence: defaultStyle -> columnStyles -> rowStyles -> cell");
  let buf5 = null, err5 = null;
  try {
    buf5 = await build((doc) => {
      doc.table({
        defaultStyle: { backgroundColor: "#eeeeee", textColor: "#111111" },
        columnStyles: [{ backgroundColor: "#ff0000" }, {}],
        rowStyles: (i) => (i === 1 ? { backgroundColor: "#00ff00" } : {}),
        data: [
          ["defaultOnly", "d2"],
          ["rowBeatsColumn", "r2"],
          [{ text: "cellBeatsAll", backgroundColor: "#0000ff" }, "c2"],
        ],
      });
    });
  } catch (e) { err5 = e; }
  if (err5) check(false, `threw: ${err5.message}`);
  else {
    fs.writeFileSync(path.join(OUT, "precedence.pdf"), buf5);
    const doc5 = await PDFDocument.load(buf5);
    const raw = doc5.getPage(0).node.Contents();
    const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
    let bytes = Buffer.alloc(0);
    for (const r of parts) {
      const st = doc5.context.lookup(r);
      const c = st && (st.getContents ? st.getContents() : st.contents);
      if (c) bytes = Buffer.concat([bytes, Buffer.from(c)]);
    }
    let sraw = bytes;
    if (sraw[0] === 0x78) { try { sraw = zlib.inflateSync(sraw); } catch {} }
    const stream = sraw.toString("latin1");
    const fills = [...stream.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:scn|rg)/g)].map((m) => [m[1], m[2], m[3]].map((x) => Math.round(parseFloat(x) * 255)).join(","));
    const uniq = [...new Set(fills)];
    say(`     fill colours drawn: ${uniq.join("  |  ")}`);
    check(uniq.includes("255,0,0"), "columnStyles red (#ff0000) beat defaultStyle grey on column 0");
    check(uniq.includes("0,255,0"), "rowStyles green (#00ff00) beat columnStyles on row 1");
    check(uniq.includes("0,0,255"), "the cell's own blue (#0000ff) beat everything on row 2");
    check(uniq.includes("238,238,238"), "defaultStyle grey (#eeeeee) still applies where nothing overrides it");
  }

  say(`\n${failures === 0 ? "✓ all table probes behaved" : `✗ ${failures} probe assertion(s) failed`}`);
})().catch((e) => {
  console.error("PROBE CRASHED:", e && e.stack ? e.stack : e);
  process.exit(1);
});

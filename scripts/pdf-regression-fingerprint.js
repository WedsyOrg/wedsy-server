/**
 * Spike harness — renders every existing PDF path and captures a comparable
 * fingerprint of each, so pdfkit 0.14 output can be diffed against 0.17.2.
 *
 * WHAT IS COMPARED, AND WHY NOT FILE BYTES
 * A PDF embeds CreationDate/ModDate and an /ID, so two runs of the SAME code
 * produce different bytes. Comparing files would report a difference every time
 * and tell us nothing. So the fingerprint is the drawing program instead:
 *
 *   · page count
 *   · per-page decoded content-stream bytes (sha256) — every glyph placement,
 *     rule, fill and image reference
 *   · the decoded TEXT, reassembled from hex/literal string operands
 *   · every text position (the Tm/Td operands), rounded, so a layout shift of
 *     even a fraction of a point is visible and locatable
 *
 * The text extraction exists because grepping raw PDF bytes is VACUOUS: pdfkit
 * writes text as hex inside kerned TJ arrays, so a raw-byte search for expected
 * content passes whether or not the content is there. proveExtractor() below
 * asserts the decoder can see known-good text before any comparison is trusted.
 *
 * Usage: node render-all.js <outDir>
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { PassThrough } = require("stream");

const REPO = path.join(__dirname, "..");
const outDir = process.argv[2] || "out";
fs.mkdirSync(outDir, { recursive: true });

const pdfkitVersion = require(path.join(REPO, "node_modules/pdfkit/package.json")).version;
const venuePdf = require(path.join(REPO, "utils/venuePdf.js"));
const { buildTermsCoverBuffer } = require(path.join(REPO, "utils/venueTermsCover.js"));
const { PDFDocument } = require(path.join(REPO, "node_modules/pdf-lib"));

// ── a mock Express response that collects the piped bytes ──────────────────
function mockRes() {
  const pt = new PassThrough();
  const chunks = [];
  pt.on("data", (c) => chunks.push(c));
  pt.setHeader = () => {};
  // utils/invoice.js collects its own chunks and calls res.status(200).end(buf)
  // instead of piping, so the mock has to satisfy both contracts.
  let ended = null;
  pt.status = () => pt;
  const origEnd = pt.end.bind(pt);
  pt.end = (buf) => { if (Buffer.isBuffer(buf)) ended = buf; return origEnd(); };
  pt.done = new Promise((resolve) => pt.on("end", () => resolve(ended || Buffer.concat(chunks))));
  return pt;
}

// ── fixtures: fixed values only, so nothing varies between runs ────────────
const FIXED = new Date("2026-11-26T06:00:00Z");
const venue = {
  _id: "venue1",
  name: "Crown Estate",
  address: "12 Palace Road, Bangalore",
  contact: { primaryPhone: "9800000000", email: "hello@crownestate.example" },
  logo: "", // no network fetch — a logo would make runs non-deterministic
};
const lineItems = [
  { name: "Grand Lawn hire", day: 1, qty: 1, unit: 200000, amount: 200000 },
  { name: "Catering — vegetarian", day: 1, qty: 300, unit: 1450, amount: 435000 },
  { name: "Décor — mandap", day: 1, qty: 1, unit: 125000, amount: 125000 },
  { name: "Rooms (12 × 2 nights)", day: 2, qty: 24, unit: 4500, amount: 108000 },
  { name: "Sound & lighting", day: 2, qty: 1, unit: 52500, amount: 52500 },
];
const totals = { subtotal: 920500, taxable: 920500, gst: 165690, grandTotal: 1086190 };
const terms = [
  "50% advance to confirm the date.",
  "Balance due 7 days before the event.",
  "No open flames inside the hall.",
  "Music off by 11pm as per local regulation.",
  "No refund within 30 days of the event.",
];
const enquiry = { _id: "enq1", coupleName: "Priya & Arjun", couplePhone: "9800001111", checkIn: FIXED };
const quote = { _id: "q1", quoteNumber: "Q-2026-014", lineItems, totals, gstPercent: 18, discount: 0, gstMode: "exclusive", terms, validUntil: FIXED, createdAt: FIXED };
const booking = { _id: "b1", coupleName: "Priya & Arjun", couplePhone: "9800001111", days: [{ date: FIXED, eventType: "wedding", guestCount: 300 }], totalValue: 1086190 };
const invoice = { _id: "i1", invoiceNumber: "INV-2026-009", lineItems, totals, gstPercent: 18, discount: 0, gstMode: "exclusive", issuedAt: FIXED, dueAt: FIXED };
const bill = { _id: "bl1", billNumber: "BILL-2026-003", lineItems, totals, gstPercent: 18, discount: 0, gstMode: "exclusive", createdAt: FIXED };
const contract = {
  _id: "c1", contractNumber: "CON-2026-005", booking,
  sections: [
    { heading: "Booking specifics", clauses: ["The Grand Lawn is reserved for 26 November 2026.", "Guest count is 300, revisable to ±10% up to 14 days before."] },
    { heading: "Payment", clauses: ["50% advance to confirm the date.", "Balance due 7 days before the event."] },
    { heading: "House rules", clauses: ["No open flames inside the hall.", "Music off by 11pm as per local regulation."] },
  ],
  acceptance: { name: "Priya Rao", acceptedAt: FIXED, ip: "203.0.113.4" },
  createdAt: FIXED,
};
const lead = {
  _id: "lead1", coupleName: "Priya & Arjun", couplePhone: "9800001111",
  contacts: [{ name: "Priya Rao", email: "priya@example.com", isPrimary: true }],
  functions: [{ name: "wedding", date: FIXED }, { name: "reception", date: new Date("2026-11-27T06:00:00Z") }],
  estimatedValue: 812500,
};
const allotment = {
  _id: "a1", guestName: "Mr Rao", guestPhone: "9800003333",
  checkInAt: FIXED, checkOutAt: new Date("2026-11-28T06:00:00Z"),
  checkOut: { damages: [{ desc: "Broken lamp — room 204", charge: 2500 }], byName: "Front desk" },
  settlement: { deposit: 10000, damagesTotal: 2500, deducted: 2500, refundDue: 7500, payableDue: 0, settledAt: FIXED },
};

// ── the documents under test ───────────────────────────────────────────────
const DOCS = [
  ["quote", (res) => venuePdf.streamQuotePdf(res, { venue, enquiry, quote })],
  ["invoice", (res) => venuePdf.streamInvoicePdf(res, { venue, booking, invoice })],
  ["bill", (res) => venuePdf.streamBillPdf(res, { venue, booking, bill })],
  ["contract", (res) => venuePdf.streamContractPdf(res, { venue, contract })],
  ["terms", (res) => venuePdf.streamTermsPdf(res, { venue, lead, sections: contract.sections, sentAt: FIXED })],
  ["settlement", (res) => venuePdf.streamSettlementPdf(res, { venue, allotment, roomName: "Room 204", booking })],
  ["legacy-invoice", (res) => { legacyInvoice.createInvoice(payment, res); }],
  ["primitives", (res) => primitivesDoc(res)],
];

/**
 * The legacy Wedsy invoice (utils/invoice.js) — a third pdfkit consumer, and the
 * only one that embeds real image assets (assets/logo-black.png, signature.png).
 * Included because the brief says every PDF path, and images plus the standard
 * fonts are exactly where a fontkit/LineWrapper change would show.
 */
const legacyInvoice = require(path.join(REPO, "utils/invoice.js"));
const payment = {
  _id: "pay1",
  amount: 1086190,
  createdAt: FIXED,
  paymentMethod: "upi",
  // invoice.js reads payment.transactions[0].method when paymentMethod is not
  // one of cash/upi/bank-transfer; both branches supplied so the fixture is
  // valid whichever it takes, and the document renders in full rather than
  // aborting half-drawn inside its own try/catch.
  transactions: [{ method: "netbanking_hdfc", amount: 1086190 }],
  paymentMode: "razorpay",
  user: { name: "Priya Rao", phone: "9800001111", email: "priya@example.com" },
  event: { _id: "6a82df7223d001628093886e", name: "Wedding — Crown Estate" },
  items: [
    { name: "Grand Lawn hire", quantity: 1, price: 200000 },
    { name: "Catering — vegetarian", quantity: 300, price: 1450 },
  ],
};

/**
 * A synthetic document exercising every pdfkit primitive our code actually
 * uses, in the shapes it uses them — BillingDocService's `continued` chains,
 * characterSpacing, lineGap and underline, plus the width-constrained wrapping
 * that the 0.17.0 LineWrapper precision fix touches. BillingDocService itself
 * reads four Mongo collections, so rather than stand up a database this probes
 * the pdfkit surface it depends on, which is what the upgrade can actually
 * change.
 */
function primitivesDoc(res) {
  const PDFKit = require(path.join(REPO, "node_modules/pdfkit"));
  const doc = new PDFKit({ size: "A4", margin: 54, compress: false });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.fontSize(22).font("Helvetica-Bold").text("WEDSY", { characterSpacing: 4 });
  doc.moveDown(0.2);
  doc.fontSize(9).font("Helvetica").fillColor("#555").text("Wedsy Technologies Private Limited");
  doc.moveDown(0.6);
  doc.fillColor("#000").fontSize(13).font("Helvetica-Bold").text("Booking agreement");
  // continued: true chains — the shape BillingDocService uses for key/value rows
  doc.font("Helvetica-Bold").text("Couple: ", { continued: true }).font("Helvetica").text("Priya & Arjun");
  doc.font("Helvetica-Bold").text("Dates: ", { continued: true }).font("Helvetica").text("26 November 2026");
  doc.moveDown(0.5);
  // lineGap + a long wrapped paragraph — the LineWrapper precision surface
  doc.fillColor("#000").fontSize(11).font("Helvetica").text(
    "This agreement is made between the venue and the couple named above. " +
      "The venue agrees to hold the date stated, subject to the payment schedule set out below, and the couple agrees to the house rules attached. " +
      "Neither party may vary these terms except in writing. " +
      "Where the guest count changes by more than ten per cent, the venue may revise the catering charge on a pro-rata basis with seven days' notice.",
    { lineGap: 4, width: 487 }
  );
  doc.moveDown(0.5);
  // underline + right/center alignment + explicit column widths
  doc.font("Helvetica-Bold").text("Tax breakup", { underline: true });
  doc.font("Helvetica").text("Taxable value: Rs. 9,20,500", { align: "left" });
  doc.font("Helvetica").text("GST 18%: Rs. 1,65,690", { align: "right", width: 487 });
  doc.font("Helvetica-Bold").text("Total (inclusive): Rs. 10,86,190", { align: "center", width: 487 });
  // rules and fills, as every venue renderer draws them
  doc.moveTo(54, doc.y + 6).lineTo(541, doc.y + 6).strokeColor("#c9a961").stroke();
  doc.moveDown(1);
  doc.rect(54, doc.y, 200, 24).fillColor("#f6f4f7").fill();
  doc.end();
}

// ── fingerprinting ─────────────────────────────────────────────────────────
/**
 * Decoded content-stream bytes for one page.
 *
 * INFLATION IS NOT OPTIONAL. startDoc() leaves pdfkit's default compression on,
 * so the six streamed documents carry FlateDecode content streams and
 * getContents() hands back the still-compressed bytes — which decode to binary
 * noise and made the extractor see zero readable text. Only the T&C cover
 * decoded, because bufferDoc() sets compress:false. Without this step the
 * comparison would have "passed" on six documents by comparing garbage to
 * garbage; the proveExtractor() gate is what surfaced it.
 */
function pageStreams(doc, i) {
  const raw = doc.getPage(i).node.Contents();
  if (!raw) return Buffer.alloc(0);
  const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
  const bufs = [];
  for (const ref of parts) {
    const s = doc.context.lookup(ref);
    if (!s) continue;
    let c = typeof s.getContents === "function" ? s.getContents() : s.contents;
    if (!c) continue;
    let buf = Buffer.from(c);
    const filter = String((s.dict && s.dict.get && s.dict.get(require(path.join(REPO, "node_modules/pdf-lib")).PDFName.of("Filter"))) || "");
    if (/Flate/.test(filter) || (buf.length > 2 && buf[0] === 0x78)) {
      try {
        buf = zlib.inflateSync(buf);
      } catch {
        try {
          buf = zlib.inflateRawSync(buf);
        } catch {
          /* leave as-is; proveExtractor will catch it */
        }
      }
    }
    bufs.push(buf);
  }
  return Buffer.concat(bufs);
}

/** Text a reader would see: hex + literal string operands, in order. */
function decodeText(stream) {
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\)/g;
  let m;
  while ((m = re.exec(stream)) !== null) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2 === 0) out += Buffer.from(hex, "hex").toString("latin1");
    } else if (m[2] !== undefined) {
      out += m[2];
    }
  }
  return out;
}

/** Every text-matrix / text-displacement position, rounded to 0.01pt. */
function textPositions(stream) {
  const pos = [];
  const tm = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g;
  let m;
  while ((m = tm.exec(stream)) !== null) {
    pos.push(`Tm ${(+m[5]).toFixed(2)},${(+m[6]).toFixed(2)}`);
  }
  const td = /([-\d.]+)\s+([-\d.]+)\s+Td/g;
  while ((m = td.exec(stream)) !== null) pos.push(`Td ${(+m[1]).toFixed(2)},${(+m[2]).toFixed(2)}`);
  return pos;
}

async function fingerprint(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pages = [];
  let allText = "";
  for (let i = 0; i < doc.getPageCount(); i++) {
    const bytes = pageStreams(doc, i);
    const stream = bytes.toString("latin1");
    const text = decodeText(stream);
    allText += text;
    pages.push({
      index: i + 1,
      streamBytes: bytes.length,
      streamSha: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      textSha: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16),
      textLen: text.length,
      positions: textPositions(stream),
      fonts: [...new Set([...stream.matchAll(/\/(F\d+)\s+([\d.]+)\s+Tf/g)].map((x) => `${x[1]}@${x[2]}`))].sort(),
    });
  }
  return { pageCount: doc.getPageCount(), pages, text: allText };
}

/**
 * The extraction MUST be proven able to see known text, or every comparison
 * below is vacuous — a decoder that returns "" makes two documents look
 * identical no matter what changed.
 */
function proveExtractor(fp, expected, label) {
  const missing = expected.filter((e) => !fp.text.includes(e));
  if (missing.length) {
    console.error(`  !! EXTRACTOR BLIND on ${label} — cannot see: ${missing.join(" | ")}`);
    console.error(`     (extracted ${fp.text.length} chars: ${JSON.stringify(fp.text.slice(0, 120))})`);
    return false;
  }
  return true;
}

(async () => {
  console.log(`pdfkit ${pdfkitVersion}  node ${process.version}  → ${outDir}\n`);
  const report = { pdfkit: pdfkitVersion, node: process.version, docs: {} };
  let blind = 0;

  for (const [name, run] of DOCS) {
    const res = mockRes();
    await run(res);
    const buf = await res.done;
    fs.writeFileSync(path.join(outDir, `${name}.pdf`), buf);
    const fp = await fingerprint(buf);
    report.docs[name] = fp;
    const sentinel = name === "legacy-invoice" ? ["Priya Rao"] : name === "primitives" ? ["WEDSY", "Booking agreement"] : ["Crown Estate"];
    const ok = proveExtractor(fp, sentinel, name);
    if (!ok) blind++;
    console.log(`  ${name.padEnd(11)} ${fp.pageCount}p  ${fp.pages.reduce((n, p) => n + p.positions.length, 0)} text positions  ${fp.text.length} chars`);
  }

  // The T&C cover page from #130 — buffer-based, not streamed.
  const cover = await buildTermsCoverBuffer({
    venue, lead, quotedAmount: 812500, issuedAt: FIXED,
    sendNote: "v2 — removed the outside-décor restriction", documentName: "Crown estate T&Cs-6.pdf",
  });
  fs.writeFileSync(path.join(outDir, "tnc-cover.pdf"), cover);
  const cfp = await fingerprint(cover);
  report.docs["tnc-cover"] = cfp;
  if (!proveExtractor(cfp, ["Crown Estate", "Priya & Arjun", "Rs. 8,12,500", "26 November"], "tnc-cover")) blind++;
  console.log(`  ${"tnc-cover".padEnd(11)} ${cfp.pageCount}p  ${cfp.pages.reduce((n, p) => n + p.positions.length, 0)} text positions  ${cfp.text.length} chars`);

  report.icu = {
    icuVersion: process.versions.icu,
    weekdayLongDate: new Date("2026-11-26T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
    plainDate: new Date("2026-11-26T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
    moneyGrouping: (812500).toLocaleString("en-IN"),
  };
  console.log(`  ICU ${report.icu.icuVersion}: weekday date renders "${report.icu.weekdayLongDate}"`);
  fs.writeFileSync(path.join(outDir, "fingerprint.json"), JSON.stringify(report, null, 2));
  console.log(`\n${blind === 0 ? "✓ extractor verified on every document" : `✗ extractor blind on ${blind} document(s) — comparisons would be vacuous`}`);
  if (blind) process.exit(1);
})().catch((e) => {
  console.error("RENDER FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});

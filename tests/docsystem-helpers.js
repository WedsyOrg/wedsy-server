/**
 * tests/docsystem-helpers.js — read a pdfkit PDF's text back off its bytes.
 * Built for compress:false output: text is literal strings in Tj/TJ runs.
 * The suite asserts on RENDERED BYTES — the standard this project holds for
 * the statement — so nothing here consults the data that built the PDF.
 */
function pdfText(buffer) {
  const raw = buffer.toString("latin1");
  const out = [];
  // literal strings inside text-showing operators, page order preserved
  const re = /\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9A-Fa-f]+)>\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push(unescapePdf(m[1]));
    else if (m[2] !== undefined) out.push(hexToText(m[2]));
    else if (m[3] !== undefined) {
      const inner = m[3];
      const re2 = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f]+)>/g;
      let m2; let s = "";
      while ((m2 = re2.exec(inner)) !== null) s += m2[1] !== undefined ? unescapePdf(m2[1]) : hexToText(m2[2]);
      out.push(s);
    }
  }
  return out;
}
function hexToText(hex) {
  let s = "";
  for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return s;
}
function unescapePdf(s) {
  return s
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

/** One string of everything, whitespace collapsed — for contains-assertions. */
function pdfFlat(buffer) {
  return pdfText(buffer).join(" ").replace(/\s+/g, " ");
}

/** WinAnsi em dash (0x97) and minus normalised so fixed-wording matches. */
function normalise(s) {
  return s.replace(/—|\x97/g, "—").replace(/−|\x96/g, "−").replace(/\s+/g, " ");
}

/**
 * Text split PER PAGE: with compress:false each page is one content stream,
 * in page order — so header/footer-on-every-page is assertable per sheet.
 */
function pdfPagesText(buffer) {
  const raw = buffer.toString("latin1");
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (/\bTJ\b|\bTj\b/.test(m[1])) streams.push(m[1]);
  }
  return streams.map((body) => pdfText(Buffer.from(body, "latin1")).join(" ").replace(/\s+/g, " "));
}

/** Page count straight off the bytes. */
function pdfPages(buffer) {
  const m = buffer.toString("latin1").match(/\/Count (\d+)/g);
  if (!m) return 0;
  return Math.max(...m.map((x) => Number(x.slice(7))));
}

module.exports = { pdfText, pdfFlat, pdfPages, pdfPagesText, normalise };

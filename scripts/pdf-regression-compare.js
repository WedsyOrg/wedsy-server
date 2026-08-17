// Diff two fingerprint.json files. Reports page count, per-page stream sha,
// text sha, and the FIRST differing text position with both values, so a
// layout shift is located rather than merely detected.
const fs = require("fs");
const A = JSON.parse(fs.readFileSync(process.argv[2] + "/fingerprint.json"));
const B = JSON.parse(fs.readFileSync(process.argv[3] + "/fingerprint.json"));
console.log(`A: pdfkit ${A.pdfkit} node ${A.node}`);
console.log(`B: pdfkit ${B.pdfkit} node ${B.node}\n`);
let diffs = 0;
const names = [...new Set([...Object.keys(A.docs), ...Object.keys(B.docs)])];
for (const n of names) {
  const a = A.docs[n], b = B.docs[n];
  if (!a || !b) { console.log(`  ${n.padEnd(11)} MISSING in ${!a ? "A" : "B"}`); diffs++; continue; }
  const issues = [];
  if (a.pageCount !== b.pageCount) issues.push(`pageCount ${a.pageCount}->${b.pageCount}`);
  const n2 = Math.min(a.pages.length, b.pages.length);
  for (let i = 0; i < n2; i++) {
    const pa = a.pages[i], pb = b.pages[i];
    if (pa.textSha !== pb.textSha) issues.push(`p${i+1} TEXT differs (${pa.textLen}->${pb.textLen} chars)`);
    if (pa.streamSha !== pb.streamSha) issues.push(`p${i+1} stream differs (${pa.streamBytes}->${pb.streamBytes}B)`);
    if (pa.positions.length !== pb.positions.length) {
      issues.push(`p${i+1} position COUNT ${pa.positions.length}->${pb.positions.length}`);
    } else {
      for (let k = 0; k < pa.positions.length; k++) {
        if (pa.positions[k] !== pb.positions[k]) { issues.push(`p${i+1} pos[${k}] "${pa.positions[k]}" -> "${pb.positions[k]}"`); break; }
      }
    }
    if (pa.fonts.join(",") !== pb.fonts.join(",")) issues.push(`p${i+1} fonts [${pa.fonts}] -> [${pb.fonts}]`);
  }
  if (a.text !== b.text) {
    let k = 0; while (k < a.text.length && k < b.text.length && a.text[k] === b.text[k]) k++;
    issues.push(`text diverges at char ${k}: ${JSON.stringify(a.text.slice(k, k+40))} -> ${JSON.stringify(b.text.slice(k, k+40))}`);
  }
  if (issues.length) { diffs++; console.log(`  ${n.padEnd(11)} DIFF`); issues.forEach(x => console.log(`      · ${x}`)); }
  else console.log(`  ${n.padEnd(11)} identical  (${a.pageCount}p, ${a.pages.reduce((s,p)=>s+p.positions.length,0)} positions, ${a.text.length} chars)`);
}
console.log(`\n${diffs === 0 ? "✓ ALL IDENTICAL" : `✗ ${diffs} document(s) differ`}`);

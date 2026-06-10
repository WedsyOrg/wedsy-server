/**
 * scripts/test-sheets-writeback.js
 *
 * Unit-style test of the Google Sheets write-back MAPPING logic — pure functions
 * only, NO live Google call and NO database. Run: node scripts/test-sheets-writeback.js
 */
const assert = require("assert");
const {
  columnIndexToLetter,
  buildRowMap,
  stageColumnLetter,
  resolveWriteTarget,
} = require("../utils/venueSheetWriteBack");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.log(`✗ ${name} — ${e.message}`); }
}

t("columnIndexToLetter handles A..Z, AA, AB, and invalid", () => {
  assert.strictEqual(columnIndexToLetter(0), "A");
  assert.strictEqual(columnIndexToLetter(7), "H");
  assert.strictEqual(columnIndexToLetter(25), "Z");
  assert.strictEqual(columnIndexToLetter(26), "AA");
  assert.strictEqual(columnIndexToLetter(27), "AB");
  assert.strictEqual(columnIndexToLetter(-1), "");
});

t("buildRowMap maps phone digits → 1-based sheet row (header offset, first wins)", () => {
  const header = ["Couple", "Phone", "Stage"];
  const rows = [
    ["Aarav", "98100-00001", "new"],     // sheet row 2
    ["Vivaan", "9810000002", "contacted"], // sheet row 3
    ["Dup", "9810000001", "lost"],        // duplicate phone → ignored (row 2 wins)
    ["NoPhone", "", "new"],               // skipped (no phone)
  ];
  const map = buildRowMap(header, rows, "Phone");
  assert.strictEqual(map["9810000001"], 2);
  assert.strictEqual(map["9810000002"], 3);
  assert.strictEqual(Object.keys(map).length, 2);
});

t("buildRowMap returns {} when phone column missing", () => {
  assert.deepStrictEqual(buildRowMap(["A", "B"], [["1", "2"]], "Phone"), {});
});

t("stageColumnLetter resolves the mapped stage column", () => {
  const header = ["Couple", "Phone", "Stage"];
  assert.strictEqual(stageColumnLetter(header, { stage: "Stage" }), "C");
  assert.strictEqual(stageColumnLetter(header, { stage: "Missing" }), ""); // indexOf -1 → ""
  assert.strictEqual(stageColumnLetter(header, {}), "");
});

t("resolveWriteTarget happy path returns A1 + value", () => {
  const integration = {
    refreshToken: "enc", spreadsheetId: "sid", sheetName: "Tab",
    stageColumn: "C", rowMap: { "9810000001": 2 },
  };
  const out = resolveWriteTarget(integration, { couplePhone: "98100-00001", stage: "booked" });
  assert.deepStrictEqual(out, { a1: "C2", value: "booked" });
});

t("resolveWriteTarget skip reasons", () => {
  const base = { refreshToken: "enc", spreadsheetId: "sid", sheetName: "Tab", stageColumn: "C", rowMap: { "9810000001": 2 } };
  assert.strictEqual(resolveWriteTarget(null, {}).skip, "not_connected");
  assert.strictEqual(resolveWriteTarget({ refreshToken: "" }, {}).skip, "not_connected");
  assert.strictEqual(resolveWriteTarget({ refreshToken: "x" }, {}).skip, "not_configured");
  assert.strictEqual(resolveWriteTarget({ ...base, stageColumn: "" }, { couplePhone: "9810000001" }).skip, "no_stage_column");
  assert.strictEqual(resolveWriteTarget(base, { couplePhone: "" }).skip, "no_phone");
  assert.strictEqual(resolveWriteTarget(base, { couplePhone: "9999999999" }).skip, "no_row");
});

console.log(`\n[test-sheets-writeback] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

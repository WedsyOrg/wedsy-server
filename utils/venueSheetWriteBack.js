/**
 * utils/venueSheetWriteBack.js
 *
 * Two-way Google Sheets write-back: when a sheet-synced lead's stage changes in
 * the dashboard, update that lead's stage cell in the source sheet.
 *
 * Design note: the per-row mapping lives on VenueSheetIntegration (rowMap +
 * stageColumn, captured at sync time) rather than on the shared VenueEnquiry
 * model — the less invasive of the two options, and it keeps VenueEnquiry
 * additive-single-field only.
 *
 * The pure helpers (columnIndexToLetter / buildRowMap / stageColumnLetter /
 * resolveWriteTarget) are unit-testable without any live Google call. The single
 * I/O entry point — writeBackLeadToSheet — is fire-and-forget and never throws;
 * it no-ops gracefully whenever creds, connection, mapping, or row are missing.
 */
const VenueSheetIntegration = require("../models/VenueSheetIntegration");
const { sheetsConfigured, decryptToken, updateCell } = require("./googleSheets");

const digitsOnly = (v) => String(v == null ? "" : v).replace(/\D/g, "");

// 0-based column index → A1 column letters. 0→A, 25→Z, 26→AA, 27→AB ...
function columnIndexToLetter(idx) {
  if (idx == null || idx < 0 || !Number.isFinite(idx)) return "";
  let n = Math.floor(idx);
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/**
 * Build { phoneDigits: sheetRowNumber } from a sheet's header + data rows.
 * sheetRowNumber is 1-based and accounts for the header row (data row i → i+2).
 * First occurrence of a phone wins, mirroring the import dedup behaviour.
 */
function buildRowMap(header, rows, phoneColName) {
  const map = {};
  if (!Array.isArray(header) || !Array.isArray(rows) || !phoneColName) return map;
  const idx = header.indexOf(phoneColName);
  if (idx < 0) return map;
  rows.forEach((rowArr, i) => {
    const phone = digitsOnly(rowArr && rowArr[idx]);
    if (phone && map[phone] == null) map[phone] = i + 2;
  });
  return map;
}

// Resolve the A1 column letter of the mapped stage column, or "" if unmapped.
function stageColumnLetter(header, columnMap) {
  const colName = columnMap && columnMap.stage;
  if (!Array.isArray(header) || !colName) return "";
  return columnIndexToLetter(header.indexOf(colName));
}

/**
 * Pure: given an integration's stored mapping state and an enquiry, return
 * either { a1, value } describing the cell to write, or { skip: <reason> }.
 */
function resolveWriteTarget(integration, enquiry) {
  if (!integration || !integration.refreshToken) return { skip: "not_connected" };
  if (!integration.spreadsheetId || !integration.sheetName) return { skip: "not_configured" };
  if (!integration.stageColumn) return { skip: "no_stage_column" };
  const phone = digitsOnly(enquiry && (enquiry.couplePhone || enquiry.phone));
  if (!phone) return { skip: "no_phone" };
  const rowMap = integration.rowMap || {};
  const row = rowMap[phone];
  if (!row) return { skip: "no_row" };
  return { a1: `${integration.stageColumn}${row}`, value: enquiry.stage };
}

/**
 * Fire-and-forget write-back for a single enquiry's stage. Never throws.
 * Returns a result object purely for logging / tests.
 */
async function writeBackLeadToSheet(enquiry) {
  try {
    if (!sheetsConfigured()) return { skipped: "not_configured" };
    if (!enquiry || !enquiry.venueId) return { skipped: "no_venue" };
    const integration = await VenueSheetIntegration.findOne({ venue: enquiry.venueId }).lean();
    const target = resolveWriteTarget(integration, enquiry);
    if (target.skip) return { skipped: target.skip };
    const refreshToken = decryptToken(integration.refreshToken);
    await updateCell(refreshToken, integration.spreadsheetId, integration.sheetName, target.a1, target.value);
    return { written: true, a1: target.a1, value: target.value };
  } catch (err) {
    console.error("[writeBackLeadToSheet] failed:", err.message);
    return { error: err.message };
  }
}

module.exports = {
  digitsOnly,
  columnIndexToLetter,
  buildRowMap,
  stageColumnLetter,
  resolveWriteTarget,
  writeBackLeadToSheet,
};

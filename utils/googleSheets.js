const crypto = require("crypto");
const { google } = require("googleapis");

// All Google credentials come from ENV only — nothing hardcoded.
//   GOOGLE_SHEETS_CLIENT_ID
//   GOOGLE_SHEETS_CLIENT_SECRET
//   GOOGLE_SHEETS_REDIRECT_URI
//   SHEETS_TOKEN_ENC_KEY      (any secret string; used to derive the AES-256 key)
//   VENUE_OWNER_APP_URL       (optional; where the OAuth callback redirects back to)

// Scopes: list spreadsheets (Drive metadata, read-only) + read AND write values
// (Sheets). The Sheets scope was widened from spreadsheets.readonly to
// spreadsheets to support stage write-back (2-way). NOTE: existing connected
// integrations were consented under the narrower scope and must RE-CONSENT
// (disconnect + reconnect) before write-back will be authorized.
const SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

function sheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_CLIENT_ID &&
      process.env.GOOGLE_SHEETS_CLIENT_SECRET &&
      process.env.GOOGLE_SHEETS_REDIRECT_URI
  );
}

function oauthClient() {
  if (!sheetsConfigured()) throw new Error("Google Sheets integration is not configured");
  return new google.auth.OAuth2(
    process.env.GOOGLE_SHEETS_CLIENT_ID,
    process.env.GOOGLE_SHEETS_CLIENT_SECRET,
    process.env.GOOGLE_SHEETS_REDIRECT_URI
  );
}

function generateAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token back
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(code) {
  const { tokens } = await oauthClient().getToken(code);
  return tokens; // { refresh_token, access_token, ... }
}

// An OAuth client primed with a stored refresh token (auto-refreshes access tokens).
function clientFromRefreshToken(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// ── Refresh-token encryption ──────────────────────────────────────────────
// Delegated to utils/secretBox.js, which is the same AES-256-GCM scheme this
// module used to implement inline. TWO THINGS ARE DELIBERATELY UNCHANGED here:
//
//   THE KEY. Still SHEETS_TOKEN_ENC_KEY, passed as an argument. Binding the
//   promoted helper to a new shared key would have stopped every existing
//   VenueSheetIntegration row decrypting — silently, and only for whoever next
//   touched a sheet.
//
//   THE LEGACY FORMAT. Rows written before the version prefix are bare
//   iv:tag:ciphertext, so reads opt into { legacy: true }. New writes carry the
//   v1.gcm: prefix, which migrates rows as they are rewritten.
const { encryptSecret, decryptSecret } = require("./secretBox");

const sheetsKey = () => process.env.SHEETS_TOKEN_ENC_KEY || "";

function encryptToken(plain) {
  if (!sheetsKey()) throw new Error("SHEETS_TOKEN_ENC_KEY is not configured");
  return encryptSecret(plain, sheetsKey());
}

function decryptToken(blob) {
  if (!sheetsKey()) throw new Error("SHEETS_TOKEN_ENC_KEY is not configured");
  return decryptSecret(blob, sheetsKey(), { legacy: true, label: "VenueSheetIntegration" });
}

// ── Sheets/Drive reads ──

async function listSpreadsheets(refreshToken) {
  const drive = google.drive({ version: "v3", auth: clientFromRefreshToken(refreshToken) });
  const resp = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: "files(id, name)",
    pageSize: 100,
    orderBy: "modifiedTime desc",
  });
  return (resp.data.files || []).map((f) => ({ id: f.id, name: f.name }));
}

async function listTabs(refreshToken, spreadsheetId) {
  const sheets = google.sheets({ version: "v4", auth: clientFromRefreshToken(refreshToken) });
  const resp = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  return (resp.data.sheets || []).map((s) => s.properties.title);
}

// Returns { header: string[], rows: string[][] } for a tab.
async function readSheetValues(refreshToken, spreadsheetId, sheetName) {
  const sheets = google.sheets({ version: "v4", auth: clientFromRefreshToken(refreshToken) });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName });
  const values = resp.data.values || [];
  if (!values.length) return { header: [], rows: [] };
  return {
    header: values[0].map((h) => String(h).trim()),
    rows: values.slice(1),
  };
}

// Write a single cell. `a1` is a cell reference within the tab, e.g. "H5".
async function updateCell(refreshToken, spreadsheetId, sheetName, a1, value) {
  const sheets = google.sheets({ version: "v4", auth: clientFromRefreshToken(refreshToken) });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${a1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

module.exports = {
  SCOPES,
  sheetsConfigured,
  generateAuthUrl,
  exchangeCode,
  encryptToken,
  decryptToken,
  listSpreadsheets,
  listTabs,
  readSheetValues,
  updateCell,
};

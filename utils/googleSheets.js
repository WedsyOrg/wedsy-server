const crypto = require("crypto");
const { google } = require("googleapis");

// All Google credentials come from ENV only — nothing hardcoded.
//   GOOGLE_SHEETS_CLIENT_ID
//   GOOGLE_SHEETS_CLIENT_SECRET
//   GOOGLE_SHEETS_REDIRECT_URI
//   SHEETS_TOKEN_ENC_KEY      (any secret string; used to derive the AES-256 key)
//   VENUE_OWNER_APP_URL       (optional; where the OAuth callback redirects back to)

// Read-only scopes: list spreadsheets (Drive metadata) + read values (Sheets).
const SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
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

// ── Refresh-token encryption (AES-256-GCM; key derived from SHEETS_TOKEN_ENC_KEY) ──

function encKey() {
  const secret = process.env.SHEETS_TOKEN_ENC_KEY;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

function encryptToken(plain) {
  const key = encKey();
  if (!key) throw new Error("SHEETS_TOKEN_ENC_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

function decryptToken(blob) {
  const key = encKey();
  if (!key) throw new Error("SHEETS_TOKEN_ENC_KEY is not configured");
  const [ivB, tagB, dataB] = String(blob).split(":");
  if (!ivB || !tagB || !dataB) throw new Error("Malformed encrypted token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
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
};

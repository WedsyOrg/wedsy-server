const jwt = require("jsonwebtoken");
const Venue = require("../models/Venue");
const VenueSheetIntegration = require("../models/VenueSheetIntegration");
const { importLeadRows } = require("./venueEnquiry");
const {
  sheetsConfigured,
  generateAuthUrl,
  exchangeCode,
  encryptToken,
  decryptToken,
  listSpreadsheets,
  listTabs,
  readSheetValues,
} = require("../utils/googleSheets");

// Resolve venue from slug and confirm the authenticated owner owns it.
async function resolveOwnedVenue(req, res) {
  const { slug } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

// Strip the encrypted token before returning an integration to the client.
function publicIntegration(doc) {
  if (!doc) return null;
  const { refreshToken, ...rest } = doc;
  return { ...rest, connected: Boolean(refreshToken) };
}

// GET /venues/:slug/integrations/google-sheets — current integration status.
const getIntegration = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const integration = await VenueSheetIntegration.findOne({ venue: venue._id }).lean();
    return res.status(200).json({ integration: publicIntegration(integration), configured: sheetsConfigured() });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/integrations/google-sheets/connect — return the consent URL.
const connect = async (req, res) => {
  try {
    if (!sheetsConfigured()) {
      return res.status(503).json({ message: "Google Sheets integration is not configured" });
    }
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    // Signed, short-lived state carries the venue identity through Google's redirect.
    const state = jwt.sign(
      { venueId: String(venue._id), slug: req.params.slug, t: "sheets_oauth" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );
    return res.status(200).json({ authUrl: generateAuthUrl(state) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/integrations/google-sheets/callback — Google redirects here.
// NOT behind venueOwnerAuth (the browser redirect from Google carries no Bearer token);
// authorized instead by verifying the signed `state` we issued in /connect.
const callback = async (req, res) => {
  try {
    if (!sheetsConfigured()) {
      return res.status(503).json({ message: "Google Sheets integration is not configured" });
    }
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).json({ message: "Missing code or state" });

    let payload;
    try {
      payload = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ message: "Invalid or expired state" });
    }
    if (payload.t !== "sheets_oauth" || !payload.venueId) {
      return res.status(400).json({ message: "Invalid state" });
    }

    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      // Google only returns a refresh token on first consent; prompt=consent should force it.
      return res.status(400).json({ message: "No refresh token returned; please reconnect." });
    }

    await VenueSheetIntegration.findOneAndUpdate(
      { venue: payload.venueId },
      { venue: payload.venueId, refreshToken: encryptToken(tokens.refresh_token), status: "connected" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const appUrl = process.env.VENUE_OWNER_APP_URL;
    if (appUrl) return res.redirect(`${appUrl}/dashboard/integrations?sheets=connected`);
    return res.status(200).send("Google Sheets connected. You can close this window and return to the dashboard.");
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/integrations/google-sheets/disconnect
const disconnect = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    await VenueSheetIntegration.findOneAndUpdate(
      { venue: venue._id },
      { refreshToken: "", status: "disconnected" }
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/integrations/google-sheets/sheets[?spreadsheetId=]
//   no spreadsheetId → list spreadsheets;  with spreadsheetId → list that file's tabs.
const listSheets = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const integration = await VenueSheetIntegration.findOne({ venue: venue._id }).lean();
    if (!integration || !integration.refreshToken) {
      return res.status(400).json({ message: "Google Sheets is not connected" });
    }
    const refreshToken = decryptToken(integration.refreshToken);
    const { spreadsheetId, sheetName } = req.query;
    if (spreadsheetId && sheetName) {
      // Header row of the chosen tab — the columns to map against.
      const { header } = await readSheetValues(refreshToken, spreadsheetId, sheetName);
      return res.status(200).json({ columns: header });
    }
    if (spreadsheetId) {
      const tabs = await listTabs(refreshToken, spreadsheetId);
      return res.status(200).json({ tabs });
    }
    const spreadsheets = await listSpreadsheets(refreshToken);
    return res.status(200).json({ spreadsheets });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/integrations/google-sheets/mapping
const saveMapping = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { spreadsheetId, sheetName, columnMap } = req.body || {};
    const integration = await VenueSheetIntegration.findOneAndUpdate(
      { venue: venue._id },
      {
        spreadsheetId: spreadsheetId || "",
        sheetName: sheetName || "",
        columnMap: columnMap && typeof columnMap === "object" ? columnMap : {},
      },
      { new: true }
    ).lean();
    if (!integration) return res.status(400).json({ message: "Google Sheets is not connected" });
    return res.status(200).json({ integration: publicIntegration(integration) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Core one-way sync (sheet → leads). Reused by manual "Sync now" and the scheduler.
// Reuses importLeadRows (the 2.1 dedup core).
async function syncIntegration(integrationDoc) {
  const integration = integrationDoc.toObject ? integrationDoc.toObject() : integrationDoc;
  if (!integration || !integration.refreshToken) throw new Error("Google Sheets is not connected");
  if (!integration.spreadsheetId || !integration.sheetName) {
    throw new Error("Spreadsheet and tab are not configured");
  }

  const refreshToken = decryptToken(integration.refreshToken);
  const { header, rows } = await readSheetValues(refreshToken, integration.spreadsheetId, integration.sheetName);

  // Map sheet rows → lead-field rows using the saved columnMap { leadField: columnHeader }.
  const columnMap = integration.columnMap || {};
  const mappedRows = rows.map((rowArr) => {
    const mapped = {};
    for (const [field, colName] of Object.entries(columnMap)) {
      const idx = header.indexOf(colName);
      mapped[field] = idx >= 0 && rowArr[idx] != null ? String(rowArr[idx]) : "";
    }
    return mapped;
  });

  const result = await importLeadRows(integration.venue, mappedRows, {
    activityDescription: "Synced from Google Sheet",
  });

  await VenueSheetIntegration.updateOne(
    { _id: integration._id },
    { lastSyncAt: new Date(), status: "connected" }
  );
  return result;
}

// POST /venues/:slug/integrations/google-sheets/sync — manual "Sync now".
const syncNow = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const integration = await VenueSheetIntegration.findOne({ venue: venue._id });
    if (!integration || !integration.refreshToken) {
      return res.status(400).json({ message: "Google Sheets is not connected" });
    }
    const result = await syncIntegration(integration);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Scheduled (every 15 min) — sync every connected, configured integration.
// No-op when creds aren't configured. One failing venue never blocks the others.
async function runScheduledSheetSync() {
  try {
    if (!sheetsConfigured()) return;
    const integrations = await VenueSheetIntegration.find({
      refreshToken: { $ne: "" },
      spreadsheetId: { $ne: "" },
      sheetName: { $ne: "" },
    });
    for (const integration of integrations) {
      try {
        await syncIntegration(integration);
      } catch (err) {
        console.error("Scheduled Google Sheets sync failed for venue", String(integration.venue), err.message);
        await VenueSheetIntegration.updateOne({ _id: integration._id }, { status: "error" }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("runScheduledSheetSync error:", err.message);
  }
}

// ── DEFERRED seam: writeBackLeadToSheet(integration, enquiry) — two-way sync
//    (lead stage → sheet row). Intentionally not implemented in the MVP.

module.exports = {
  getIntegration,
  connect,
  callback,
  disconnect,
  listSheets,
  saveMapping,
  syncNow,
  syncIntegration,
  runScheduledSheetSync,
};

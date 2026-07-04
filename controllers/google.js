const GoogleWorkspaceService = require("../services/GoogleWorkspaceService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

const Start = async (req, res) => {
  try {
    res.status(200).json({ url: GoogleWorkspaceService.startUrl(req.auth.user_id) });
  } catch (error) {
    respond(res, error);
  }
};

// Browser redirect target — no Authorization header here; identity rides the
// signed state. Renders a tiny self-closing page.
const Callback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");
    const account = await GoogleWorkspaceService.handleCallback(code, state);
    res
      .status(200)
      .send(
        `<html><body style="font-family:sans-serif;padding:40px;text-align:center">` +
          `<h2>Google connected ✓</h2><p>${account.email || ""} is linked to Wedsy OS.</p>` +
          `<p>You can close this tab and head back.</p></body></html>`
      );
  } catch (error) {
    res
      .status(error.status || 500)
      .send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Link failed</h2><p>${error.message}</p></body></html>`);
  }
};

const Status = async (req, res) => {
  try {
    res.status(200).json(await GoogleWorkspaceService.status(req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

const Disconnect = async (req, res) => {
  try {
    res.status(200).json(await GoogleWorkspaceService.disconnect(req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

const Availability = async (req, res) => {
  try {
    res.status(200).json(
      await GoogleWorkspaceService.availability(req.query.leadId, {
        from: req.query.from,
        days: parseInt(req.query.days, 10) || 5,
      })
    );
  } catch (error) {
    respond(res, error);
  }
};

const Book = async (req, res) => {
  try {
    const { leadId, start, end } = req.body || {};
    res.status(200).json(await GoogleWorkspaceService.bookMeet(leadId, { start, end }, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Start, Callback, Status, Disconnect, Availability, Book };

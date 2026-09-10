const GoogleWorkspaceService = require("../services/GoogleWorkspaceService");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

const Start = async (req, res) => {
  try {
    // The OS may say which page it is sending the person from; when it does not
    // (the current frontend does not yet), the service falls back to account
    // settings. Optional on purpose — a caller that never learns about this
    // parameter keeps working.
    res.status(200).json({ url: GoogleWorkspaceService.startUrl(req.auth.user_id, req.query.origin) });
  } catch (error) {
    respond(res, error);
  }
};

// Browser redirect target — no Authorization header here; identity rides the
// signed state.
//
// EVERY EXIT FROM HERE IS A REDIRECT BACK INTO THE OS. It used to render HTML
// on prod.server.wedsy.in, which left people on a server page outside the
// product with no way back but the browser's history. The failure exits were
// worse than the success one: a person who pressed Cancel at Google's consent
// screen got a bare "Missing code/state" with status 400, because a denial
// arrives as ?error=access_denied with NO code and fell through the same guard
// as a malformed request. They were told the system was broken when they had
// simply changed their mind.
//
// The flag is a fixed slug in the query string. Raw error messages are NOT
// echoed: they leak internals into a URL and into whatever renders it.
const Callback = async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Google's own refusal — the user pressed Cancel, or consent was withheld.
  // Checked FIRST, because it also arrives without a code and would otherwise
  // be reported as a malformed request.
  if (oauthError) {
    const reason = String(oauthError) === "access_denied" ? "denied" : "refused";
    return res.redirect(
      GoogleWorkspaceService.osReturnUrl(GoogleWorkspaceService.originFromState(state), `google=error&reason=${reason}`)
    );
  }

  if (!code || !state) {
    return res.redirect(
      GoogleWorkspaceService.osReturnUrl(GoogleWorkspaceService.originFromState(state), "google=error&reason=incomplete")
    );
  }

  try {
    await GoogleWorkspaceService.handleCallback(code, state);
    // originFromState re-verifies rather than trusting a value handleCallback
    // happened to see: the destination of a 302 is worth deriving from a
    // checked signature every time.
    return res.redirect(GoogleWorkspaceService.osReturnUrl(GoogleWorkspaceService.originFromState(state), "google=connected"));
  } catch (error) {
    // A slug per failure, so the OS can say something useful without this
    // handler shipping internals into the address bar.
    const reason =
      error.status === 403 ? "expired" : error.status === 409 ? "unconfigured" : "failed";
    return res.redirect(
      GoogleWorkspaceService.osReturnUrl(GoogleWorkspaceService.originFromState(state), `google=error&reason=${reason}`)
    );
  }
};

const Status = async (req, res) => {
  try {
    res.status(200).json(await GoogleWorkspaceService.status(req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /google/link-roster — team-wide link status. Read-only.
const LinkRoster = async (req, res) => {
  try {
    res.status(200).json(await GoogleWorkspaceService.linkRoster());
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "Something went wrong" });
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

module.exports = { Start, Callback, Status, LinkRoster, Disconnect, Availability, Book };

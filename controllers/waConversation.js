const WAConversationService = require("../services/WAConversationService");

// Admin chat API over the Kiara WhatsApp line (Slice 4). RBAC-scoped through
// the linked enquiry: requirePermission builds req.scopeFilter on assignedTo
// with the same semantics as every lead route.
const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[waConversation]", error);
  const body = { message: status === 500 ? "Server error" : error.message };
  if (error.windowClosed) {
    body.windowClosed = true;
    body.windowClosesAt = error.windowClosesAt || null;
  }
  res.status(status).json(body);
};

// GET /wa/conversations?mode=&needsHuman=&status=&page=&limit=
const List = async (req, res) => {
  try {
    const { mode, needsHuman, status, page, limit } = req.query;
    const result = await WAConversationService.listInbox(
      { mode, needsHuman, status, page, limit },
      req.scopeFilter || {}
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// GET /wa/conversations/:id/messages?page=&limit= — marks the thread read.
const Messages = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const result = await WAConversationService.getMessages(
      req.params.id,
      { page, limit },
      req.scopeFilter || {}
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// POST /wa/conversations/:id/takeover — mode='human', STICKY until handback.
const Takeover = async (req, res) => {
  try {
    const conversation = await WAConversationService.takeover(
      req.params.id,
      req.auth.user_id,
      req.scopeFilter || {}
    );
    res.status(200).json(conversation);
  } catch (error) {
    respond(res, error);
  }
};

// POST /wa/conversations/:id/handback — Kiara resumes.
const Handback = async (req, res) => {
  try {
    const conversation = await WAConversationService.handback(
      req.params.id,
      req.auth.user_id,
      req.scopeFilter || {}
    );
    res.status(200).json(conversation);
  } catch (error) {
    respond(res, error);
  }
};

// POST /wa/conversations/:id/send {text} — human mode + open 24h window only.
const Send = async (req, res) => {
  try {
    const result = await WAConversationService.sendText(
      req.params.id,
      (req.body || {}).text,
      req.auth.user_id,
      req.scopeFilter || {}
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// POST /wa/conversations/:id/send-template — re-engage template, window-proof.
const SendTemplate = async (req, res) => {
  try {
    const result = await WAConversationService.sendTemplate(
      req.params.id,
      req.auth.user_id,
      req.scopeFilter || {}
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Messages, Takeover, Handback, Send, SendTemplate };

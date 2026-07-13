const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const NurtureService = require("../services/NurtureService");

const respond = (res, error) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? "Something went wrong with nurture — please retry." : error.message });
};

const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// ── Nurture Library CRUD (founder-editable, settings_nurture) ──────────────────
const ListTemplates = async (req, res) => {
  try {
    res.status(200).json({ list: await NurtureService.listTemplates() });
  } catch (error) {
    respond(res, error);
  }
};

const CreateTemplate = async (req, res) => {
  try {
    res.status(201).json(await NurtureService.createTemplate(req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

const UpdateTemplate = async (req, res) => {
  try {
    res.status(200).json(await NurtureService.updateTemplate(req.params._id, req.body || {}));
  } catch (error) {
    respond(res, error);
  }
};

const DeleteTemplate = async (req, res) => {
  try {
    res.status(200).json(await NurtureService.deleteTemplate(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// ── WhatsApp-group one-tap toggle (the red-flag → Yes flip on the Client File) ──
// POST /enquiry/:_id/whatsapp-group  { created: true }
const SetGroup = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const created = (req.body || {}).created;
    if (typeof created !== "boolean") throw Object.assign(new Error("created must be a boolean"), { status: 400 });
    const result = await NurtureService.applyGroupAnswer(req.params._id, created, req.auth.user_id);
    res.status(200).json(result || { ok: true });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { ListTemplates, CreateTemplate, UpdateTemplate, DeleteTemplate, SetGroup };

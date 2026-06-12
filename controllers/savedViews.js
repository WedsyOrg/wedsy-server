const mongoose = require("mongoose");
const SavedView = require("../models/SavedView");
const { buildFilterConditions } = require("../utils/leadFilterBuilder");

const respond = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });
const httpError = (status, message) => Object.assign(new Error(message), { status });

const LIFECYCLE_VIEWS = ["", "active", "meeting", "won", "recycled", "lost", "triage"];

const validateBody = async ({ name, filters, view }) => {
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 60)) {
    throw httpError(400, "name must be a string of 1–60 chars");
  }
  if (filters !== undefined) {
    if (!Array.isArray(filters)) throw httpError(400, "filters must be an array");
    await buildFilterConditions(filters); // strict whitelist — throws 400 on junk
  }
  if (view !== undefined && !LIFECYCLE_VIEWS.includes(view)) {
    throw httpError(400, "Unknown view");
  }
};

const List = async (req, res) => {
  try {
    const list = await SavedView.find({ adminId: req.auth.user_id }).sort({ createdAt: 1 }).lean();
    res.status(200).json({ list });
  } catch (error) {
    respond(res, error);
  }
};

const Create = async (req, res) => {
  try {
    const { name, filters = [], view = "", isDefault = false } = req.body || {};
    if (!name) throw httpError(400, "name is required");
    await validateBody({ name, filters, view });
    if (isDefault) {
      await SavedView.updateMany({ adminId: req.auth.user_id }, { $set: { isDefault: false } });
    }
    const created = await SavedView.create({
      adminId: req.auth.user_id,
      name: name.trim(),
      filters,
      view,
      isDefault: !!isDefault,
    });
    res.status(201).json(created);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "You already have a view with that name" });
    respond(res, error);
  }
};

const Update = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(400, "Invalid id");
    const { name, filters, view, isDefault } = req.body || {};
    await validateBody({ name, filters, view });
    const set = {};
    if (name !== undefined) set.name = name.trim();
    if (filters !== undefined) set.filters = filters;
    if (view !== undefined) set.view = view;
    if (isDefault !== undefined) {
      if (isDefault) {
        await SavedView.updateMany({ adminId: req.auth.user_id }, { $set: { isDefault: false } });
      }
      set.isDefault = !!isDefault;
    }
    const updated = await SavedView.findOneAndUpdate(
      { _id: req.params.id, adminId: req.auth.user_id },
      { $set: set },
      { new: true }
    );
    if (!updated) throw httpError(404, "Saved view not found");
    res.status(200).json(updated);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "You already have a view with that name" });
    respond(res, error);
  }
};

const Delete = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(400, "Invalid id");
    const deleted = await SavedView.findOneAndDelete({ _id: req.params.id, adminId: req.auth.user_id });
    if (!deleted) throw httpError(404, "Saved view not found");
    res.status(200).json({ ok: true });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Create, Update, Delete };
